const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { insertNotification } = require('../notifications');
const {
  ensureRefundRequestsTable,
  listRefundRequests,
} = require('../services/refundRequestService');

const router = express.Router();

const cache = new Map();
let adminColumnsPromise = null;
let financeTablesPromise = null;

async function hasTable(tableName) {
  const key = `table.${tableName}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const [rows] = await db.query('SHOW TABLES LIKE ?', [tableName]);
    const exists = rows.length > 0;
    cache.set(key, exists);
    return exists;
  } catch (_) {
    cache.set(key, false);
    return false;
  }
}

async function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const [rows] = await db.query(`SHOW COLUMNS FROM ${tableName} LIKE ?`, [
      columnName,
    ]);
    const exists = rows.length > 0;
    cache.set(key, exists);
    return exists;
  } catch (_) {
    cache.set(key, false);
    return false;
  }
}

async function ensureAdminColumnsImpl() {
  if (!(await hasColumn('user', 'isActive'))) {
    await db.query(
      'ALTER TABLE user ADD COLUMN isActive TINYINT(1) NOT NULL DEFAULT 1',
    );
    cache.set('user.isActive', true);
  }
  await db.query('UPDATE user SET isActive = 1 WHERE isActive IS NULL');

  if (!(await hasColumn('careprovider', 'approvalStatus'))) {
    await db.query(
      "ALTER TABLE careprovider ADD COLUMN approvalStatus VARCHAR(24) NOT NULL DEFAULT 'pending'",
    );
    cache.set('careprovider.approvalStatus', true);
    await db.query(
      "UPDATE careprovider SET approvalStatus = 'approved' WHERE approvalStatus IS NULL OR approvalStatus = ''",
    );
  }
  const careProviderColumns = [
    ['is_rate_approved', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['hourly_rate', 'DECIMAL(10,2) NOT NULL DEFAULT 0'],
    ['status', "VARCHAR(24) NOT NULL DEFAULT 'pending'"],
    ['experience_level', "VARCHAR(24) NOT NULL DEFAULT 'junior'"],
    ['license_number', 'VARCHAR(120) NULL'],
    ['years_experience', 'INT NULL'],
    ['experience_tier', "VARCHAR(24) NOT NULL DEFAULT 'junior'"],
    ['serviceAreas', 'TEXT NULL'],
    ['biography', 'TEXT NULL'],
    ['previousWorkplaces', 'TEXT NULL'],
    ['homeCareAvailable', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ];
  for (const [column, definition] of careProviderColumns) {
    if (!(await hasColumn('careprovider', column))) {
      await db.query(`ALTER TABLE careprovider ADD COLUMN ${column} ${definition}`);
      cache.set(`careprovider.${column}`, true);
    }
  }

  if (await hasTable('provider_certification')) {
    if (!(await hasColumn('provider_certification', 'isVerified'))) {
      await db.query(
        'ALTER TABLE provider_certification ADD COLUMN isVerified TINYINT(1) NOT NULL DEFAULT 0',
      );
      cache.set('provider_certification.isVerified', true);
    }
    if (!(await hasColumn('provider_certification', 'verifiedAt'))) {
      await db.query(
        'ALTER TABLE provider_certification ADD COLUMN verifiedAt DATETIME NULL',
      );
      cache.set('provider_certification.verifiedAt', true);
    }
    const fileColumns = [
      ['fileUrl', 'LONGTEXT NULL'],
      ['originalName', 'VARCHAR(512) NULL'],
      ['mimeType', 'VARCHAR(160) NULL'],
      ['fileSize', 'BIGINT NULL'],
    ];
    for (const [column, definition] of fileColumns) {
      if (!(await hasColumn('provider_certification', column))) {
        await db.query(
          `ALTER TABLE provider_certification ADD COLUMN ${column} ${definition}`,
        );
        cache.set(`provider_certification.${column}`, true);
      }
    }
    try {
      await db.query('ALTER TABLE provider_certification MODIFY COLUMN fileUrl LONGTEXT NULL');
      cache.set('provider_certification.fileUrl', true);
    } catch (_) {}
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_documents (
      documentId CHAR(36) NOT NULL PRIMARY KEY,
      providerUserId CHAR(36) NOT NULL,
      medical_certificate LONGTEXT NULL,
      nursing_license LONGTEXT NULL,
      id_card LONGTEXT NULL,
      cv_file LONGTEXT NULL,
      workplace_history TEXT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_provider_documents_provider (providerUserId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  for (const column of ['medical_certificate', 'nursing_license', 'id_card', 'cv_file']) {
    try {
      await db.query(`ALTER TABLE provider_documents MODIFY COLUMN ${column} LONGTEXT NULL`);
      cache.set(`provider_documents.${column}`, true);
    } catch (_) {}
  }

  const serviceRequestReviewColumns = [
    ['paymentStatus', "VARCHAR(32) NULL"],
    ['completedAt', 'DATETIME NULL'],
    ['adminReviewStatus', "VARCHAR(32) NULL"],
    ['adminReviewDecision', "VARCHAR(32) NULL"],
    ['adminReviewNotes', 'TEXT NULL'],
    ['adminReviewedAt', 'DATETIME NULL'],
  ];
  for (const [column, definition] of serviceRequestReviewColumns) {
    if (!(await hasColumn('servicerequest', column))) {
      await db.query(`ALTER TABLE servicerequest ADD COLUMN ${column} ${definition}`);
      cache.set(`servicerequest.${column}`, true);
    }
  }
}

async function ensureAdminColumns() {
  if (!adminColumnsPromise) {
    adminColumnsPromise = ensureAdminColumnsImpl().catch((error) => {
      adminColumnsPromise = null;
      throw error;
    });
  }
  return adminColumnsPromise;
}

function num(value) {
  return Number(value || 0);
}

async function getMetrics() {
  const [[users]] = await db.query(`
    SELECT
      SUM(BINARY CAST(role AS CHAR) = BINARY 'patient') AS patients,
      SUM(BINARY CAST(role AS CHAR) = BINARY 'nurse') AS nurses,
      SUM(BINARY CAST(role AS CHAR) = BINARY 'doctor') AS doctors,
      SUM(BINARY CAST(role AS CHAR) = BINARY 'admin') AS admins,
      COUNT(*) AS totalUsers,
      SUM(COALESCE(isActive, 1) = 0) AS inactiveUsers
    FROM user
  `);

  const [[providers]] = await db.query(`
    SELECT
      SUM(BINARY CAST(approvalStatus AS CHAR) = BINARY 'pending') AS pendingProviders,
      SUM(BINARY CAST(approvalStatus AS CHAR) = BINARY 'approved') AS approvedProviders,
      SUM(BINARY CAST(approvalStatus AS CHAR) = BINARY 'rejected') AS rejectedProviders,
      COALESCE(AVG(overallRating), 0) AS averageProviderRating
    FROM careprovider
  `);

  const [[requests]] = await db.query(`
    SELECT
      COUNT(*) AS totalRequests,
      SUM(BINARY CAST(status AS CHAR) = BINARY 'pending') AS pendingRequests,
      SUM(BINARY CAST(status AS CHAR) IN (BINARY 'completed', BINARY 'done')) AS completedRequests,
      SUM(BINARY CAST(status AS CHAR) IN (BINARY 'cancelled', BINARY 'canceled')) AS cancelledRequests
    FROM servicerequest
  `);

  let ratings = { totalRatings: 0, averageStars: 0 };
  if (await hasTable('providervisitrating')) {
    const [[row]] = await db.query(`
      SELECT COUNT(*) AS totalRatings, COALESCE(AVG(stars), 0) AS averageStars
      FROM providervisitrating
    `);
    ratings = row;
  }

  let payments = { paidAmount: 0, paidCount: 0 };
  if (await hasTable('payment')) {
    const [[row]] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN BINARY CAST(paymentStatus AS CHAR) = BINARY 'paid' THEN amount ELSE 0 END), 0) AS paidAmount,
        SUM(BINARY CAST(paymentStatus AS CHAR) = BINARY 'paid') AS paidCount
      FROM payment
    `);
    payments = row;
  }

  return {
    totalUsers: num(users.totalUsers),
    patients: num(users.patients),
    nurses: num(users.nurses),
    doctors: num(users.doctors),
    admins: num(users.admins),
    inactiveUsers: num(users.inactiveUsers),
    pendingProviders: num(providers.pendingProviders),
    approvedProviders: num(providers.approvedProviders),
    rejectedProviders: num(providers.rejectedProviders),
    averageProviderRating: Number(providers.averageProviderRating || 0),
    totalRequests: num(requests.totalRequests),
    pendingRequests: num(requests.pendingRequests),
    completedRequests: num(requests.completedRequests),
    cancelledRequests: num(requests.cancelledRequests),
    totalRatings: num(ratings.totalRatings),
    averageStars: Number(ratings.averageStars || 0),
    paidAmount: Number(payments.paidAmount || 0),
    paidCount: num(payments.paidCount),
  };
}

async function getRegistrationRequests() {
  const hasUserCreatedAt = await hasColumn('user', 'createdAt');
  const hasProfileImageUrl = await hasColumn('user', 'profileImageUrl');
  const userCreatedAtSelect = hasUserCreatedAt ? 'u.createdAt' : 'NULL AS createdAt';
  const userCreatedAtGroup = hasUserCreatedAt ? ', u.createdAt' : '';
  const profileImageSelect = hasProfileImageUrl
    ? 'u.profileImageUrl'
    : 'NULL AS profileImageUrl';
  const profileImageGroup = hasProfileImageUrl ? ', u.profileImageUrl' : '';

  const [rows] = await db.query(`
    SELECT
      u.userId,
      u.fullName,
      u.email,
      u.phone,
      u.role,
      ${profileImageSelect},
      ${userCreatedAtSelect},
      COALESCE(u.isActive, 1) AS isActive,
      cp.specialization,
      cp.experienceYears,
      cp.years_experience,
      cp.experience_tier,
      cp.experience_level,
      cp.serviceType,
      cp.licenseNumber,
      cp.license_number,
      cp.serviceAreas,
      cp.biography,
      cp.previousWorkplaces,
      cp.homeCareAvailable,
      cp.providerAddress,
      cp.overallRating,
      COALESCE(cp.approvalStatus, 'pending') AS approvalStatus,
      COUNT(pc.certId) AS certificationCount,
      SUM(COALESCE(pc.isVerified, 0) = 1) AS verifiedCertificationCount,
      COUNT(DISTINCT pd.documentId) AS documentCount
    FROM user u
    JOIN careprovider cp ON BINARY cp.userId = BINARY u.userId
    LEFT JOIN provider_certification pc ON BINARY pc.providerUserId = BINARY u.userId
    LEFT JOIN provider_documents pd ON BINARY pd.providerUserId = BINARY u.userId
    WHERE BINARY CAST(u.role AS CHAR) IN (BINARY 'nurse', BINARY 'doctor')
    GROUP BY
      u.userId, u.fullName, u.email, u.phone, u.role${profileImageGroup}${userCreatedAtGroup}, u.isActive,
      cp.specialization, cp.experienceYears, cp.years_experience,
      cp.experience_tier, cp.experience_level, cp.serviceType,
      cp.licenseNumber, cp.license_number, cp.serviceAreas, cp.biography,
      cp.previousWorkplaces, cp.homeCareAvailable, cp.providerAddress,
      cp.overallRating, cp.approvalStatus
    ORDER BY
      CASE BINARY COALESCE(CAST(cp.approvalStatus AS CHAR), 'pending')
        WHEN BINARY 'pending' THEN 1
        WHEN BINARY 'rejected' THEN 2
        WHEN BINARY 'approved' THEN 3
        ELSE 4
      END,
      u.fullName
  `);
  return rows.map((row) => ({
    ...row,
    isActive: Boolean(row.isActive),
    experienceTier:
      row.experience_tier ||
      row.experience_level ||
      (Number(row.experienceYears || row.years_experience || 0) >= 8
        ? 'senior'
        : Number(row.experienceYears || row.years_experience || 0) >= 3
          ? 'mid'
          : 'junior'),
    certificationCount: num(row.certificationCount),
    verifiedCertificationCount: num(row.verifiedCertificationCount),
    documentCount: num(row.documentCount),
  }));
}

async function getUsers(role = 'all') {
  const userCreatedAtSelect = (await hasColumn('user', 'createdAt'))
    ? 'u.createdAt'
    : 'NULL AS createdAt';
  const profileImageSelect = (await hasColumn('user', 'profileImageUrl'))
    ? 'u.profileImageUrl'
    : 'NULL AS profileImageUrl';
  const params = [];
  let where = "WHERE BINARY CAST(u.role AS CHAR) IN (BINARY 'patient', BINARY 'nurse', BINARY 'doctor')";
  if (['patient', 'nurse', 'doctor'].includes(role)) {
    where += ' AND BINARY CAST(u.role AS CHAR) = BINARY ?';
    params.push(role);
  }

  const [rows] = await db.query(
    `
    SELECT
      u.userId,
      u.fullName,
      u.email,
      u.phone,
      u.role,
      ${profileImageSelect},
      ${userCreatedAtSelect},
      COALESCE(u.isActive, 1) AS isActive,
      cp.specialization,
      cp.serviceType,
      cp.overallRating,
      COALESCE(
        cp.approvalStatus,
        CASE WHEN BINARY CAST(u.role AS CHAR) = BINARY 'patient' THEN 'approved' ELSE 'pending' END
      ) AS approvalStatus,
      p.addressText
    FROM user u
    LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY u.userId
    LEFT JOIN patient p ON BINARY p.userId = BINARY u.userId
    ${where}
    ORDER BY u.role, u.fullName
    `,
    params,
  );

  return rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) }));
}

async function getCertifications(providerId) {
  const certRows = [];
  if (await hasTable('provider_certification')) {
    const [rows] = await db.query(
      `
      SELECT certId, providerUserId, name, fileUrl, originalName, mimeType, fileSize,
             createdAt, COALESCE(isVerified, 0) AS isVerified, verifiedAt
      FROM provider_certification
      WHERE BINARY providerUserId = BINARY ?
      ORDER BY createdAt DESC
      `,
      [providerId],
    );
    certRows.push(
      ...rows.map((row) => {
        const certId = row.certId?.toString() || '';
        const fileUrl = (row.fileUrl || '').toString().trim();
        return {
          ...row,
          fileUrl: listSafeFileUrl(certId, fileUrl),
          isVerified: Boolean(row.isVerified),
          hasEmbeddedFile: fileUrl.startsWith('data:'),
        };
      }),
    );
  }

  const documents = await getProviderDocuments(providerId);
  const documentLabels = [
    ['cv_file', 'CV File'],
    ['medical_certificate', 'Medical Certificate'],
    ['id_card', 'ID Card'],
    ['nursing_license', 'Nursing License'],
  ];
  for (const doc of documents) {
    for (const [field, name] of documentLabels) {
      const fileUrl = (doc[field] || '').toString().trim();
      if (!fileUrl) continue;
      const certId = `document:${doc.documentId}:${field}`;
      certRows.push({
        certId,
        providerUserId: doc.providerUserId,
        name,
        fileUrl: listSafeFileUrl(certId, fileUrl),
        originalName: 'Attached file',
        mimeType: mimeFromFileValue(fileUrl),
        fileSize: null,
        createdAt: doc.createdAt,
        isVerified: true,
        verifiedAt: doc.updatedAt,
        documentField: field,
      });
    }
  }

  return certRows;
}

function listSafeFileUrl(certId, fileUrl) {
  const value = (fileUrl || '').toString().trim();
  if (!value.startsWith('data:')) return value;
  return `/admin/certifications/${encodeURIComponent(certId)}/file`;
}

function parseDataUrl(value) {
  const text = (value || '').toString().trim();
  const match = text.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  try {
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
    };
  } catch (_) {
    return null;
  }
}

function mimeFromFileValue(value) {
  const text = (value || '').toString().trim().toLowerCase();
  const dataMatch = text.match(/^data:([^;,]+);base64,/);
  if (dataMatch) return dataMatch[1];
  if (text.endsWith('.pdf')) return 'application/pdf';
  if (text.endsWith('.png')) return 'image/png';
  if (text.endsWith('.jpg') || text.endsWith('.jpeg')) return 'image/jpeg';
  if (text.endsWith('.webp')) return 'image/webp';
  return '';
}

function sniffFileType(buffer, fallbackMimeType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { mimeType: fallbackMimeType || 'application/octet-stream', ext: 'bin', valid: false };
  }
  if (buffer.subarray(0, 4).toString('utf8') === '%PDF') {
    return { mimeType: 'application/pdf', ext: 'pdf', valid: true };
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mimeType: 'image/png', ext: 'png', valid: true };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg', valid: true };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: 'webp', valid: true };
  }
  return { mimeType: fallbackMimeType || 'application/octet-stream', ext: 'bin', valid: false };
}

function sendInvalidFileMessage(res) {
  res.status(422);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Invalid file</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 32px; color: #183236; }
          .box { max-width: 560px; border: 1px solid #d7e7e5; border-radius: 16px; padding: 22px; }
          h1 { font-size: 20px; margin: 0 0 12px; color: #0f766e; }
          p { line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>File needs to be uploaded again</h1>
          <p>This old document was saved in an incomplete format, so it cannot be previewed as a PDF or image.</p>
          <p>Please ask the provider to upload the document again. New uploads will be saved as full files.</p>
        </div>
      </body>
    </html>
  `);
}

async function getCertificationFileRecord(certId) {
  const id = (certId || '').toString();
  if (id.startsWith('document:')) {
    const [, documentId, field] = id.split(':');
    const allowed = new Set([
      'cv_file',
      'medical_certificate',
      'id_card',
      'nursing_license',
    ]);
    if (!documentId || !allowed.has(field)) return null;
    const [[doc]] = await db.query(
      `SELECT documentId, ${field} AS fileUrl, updatedAt
       FROM provider_documents
       WHERE documentId = ?
       LIMIT 1`,
      [documentId],
    );
    if (!doc || !doc.fileUrl) return null;
    const names = {
      cv_file: 'CV File',
      medical_certificate: 'Medical Certificate',
      id_card: 'ID Card',
      nursing_license: 'Nursing License',
    };
    return {
      name: names[field] || 'Document',
      fileUrl: doc.fileUrl,
      originalName: `${names[field] || 'document'}.${extensionFromMimeOrValue(
        mimeFromFileValue(doc.fileUrl),
        doc.fileUrl,
      )}`,
      mimeType: mimeFromFileValue(doc.fileUrl),
    };
  }

  const [[cert]] = await db.query(
    `SELECT name, fileUrl, originalName, mimeType
     FROM provider_certification
     WHERE certId = ?
     LIMIT 1`,
    [id],
  );
  return cert || null;
}

function extensionFromMimeOrValue(mimeType, value) {
  const text = (value || '').toString().trim().toLowerCase();
  const extMatch = text.match(/\.([a-z0-9]+)(?:\?.*)?$/);
  if (extMatch) return extMatch[1];
  const map = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
  };
  return map[(mimeType || '').toLowerCase()] || 'bin';
}

async function getRatings() {
  if (!(await hasTable('providervisitrating'))) return [];
  const hasProfileImageUrl = await hasColumn('user', 'profileImageUrl');
  const [rows] = await db.query(`
    SELECT
      r.ratingId,
      r.requestId,
      r.stars,
      r.comment,
      r.createdAt,
      pu.fullName AS patientName,
      ${hasProfileImageUrl ? 'pu.profileImageUrl' : 'NULL'} AS profileImageUrl,
      pr.fullName AS providerName,
      pr.role AS providerRole,
      sr.serviceType
    FROM providervisitrating r
    LEFT JOIN user pu ON BINARY pu.userId = BINARY r.patientUserId
    LEFT JOIN user pr ON BINARY pr.userId = BINARY r.providerUserId
    LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY r.requestId
    ORDER BY r.createdAt DESC
    LIMIT 100
  `);
  return rows;
}

async function getPerformance() {
  const hasVisitAddress = await hasColumn('servicerequest', 'visitAddress');
  const hasLocationNote = await hasColumn('servicerequest', 'locationNote');
  const hasCreatedAt = await hasColumn('servicerequest', 'createdAt');
  const hasProfileImageUrl = await hasColumn('user', 'profileImageUrl');
  const requestLocationSelect = hasVisitAddress
    ? "COALESCE(NULLIF(sr.visitAddress, ''), NULLIF(sr.location, ''), NULLIF(sr.notes, ''), '')"
    : hasLocationNote
      ? "COALESCE(NULLIF(sr.location, ''), NULLIF(sr.locationNote, ''), NULLIF(sr.notes, ''), '')"
      : "COALESCE(NULLIF(sr.location, ''), NULLIF(sr.notes, ''), '')";
  const requestCreatedAtSelect = hasCreatedAt ? 'sr.createdAt' : 'NULL';

  const [statusRows] = await db.query(`
    SELECT status, COUNT(*) AS count
    FROM servicerequest
    GROUP BY status
    ORDER BY count DESC
  `);

  const [serviceRows] = await db.query(`
    SELECT serviceType, COUNT(*) AS count
    FROM servicerequest
    GROUP BY serviceType
    ORDER BY count DESC
    LIMIT 8
  `);

  const [providerRows] = await db.query(`
    SELECT
      u.userId,
      u.fullName,
      u.role,
      cp.specialization,
      cp.overallRating,
      COUNT(sr.requestId) AS totalVisits,
      SUM(BINARY CAST(sr.status AS CHAR) IN (BINARY 'completed', BINARY 'done')) AS completedVisits
    FROM user u
    JOIN careprovider cp ON BINARY cp.userId = BINARY u.userId
    LEFT JOIN servicerequest sr ON BINARY sr.providerUserId = BINARY u.userId
    WHERE BINARY CAST(u.role AS CHAR) IN (BINARY 'nurse', BINARY 'doctor')
    GROUP BY u.userId, u.fullName, u.role, cp.specialization, cp.overallRating
    ORDER BY completedVisits DESC, cp.overallRating DESC
    LIMIT 10
  `);

  const [requestRows] = await db.query(`
    SELECT
      sr.requestId,
      sr.patientUserId,
      sr.providerUserId,
      sr.serviceType,
      sr.status,
      ${requestLocationSelect} AS location,
      sr.scheduledAt,
      ${requestCreatedAtSelect} AS createdAt,
      COALESCE(p.final_amount, p.amount, 0) AS paidAmount,
      COALESCE(p.paymentStatus, 'pending') AS paymentStatus,
      pu.fullName AS patientName,
      ${hasProfileImageUrl ? 'pu.profileImageUrl' : 'NULL'} AS profileImageUrl,
      pr.fullName AS providerName,
      pr.role AS providerRole
    FROM servicerequest sr
    LEFT JOIN payment p ON BINARY p.requestId = BINARY sr.requestId
    LEFT JOIN user pu ON BINARY pu.userId = BINARY sr.patientUserId
    LEFT JOIN user pr ON BINARY pr.userId = BINARY sr.providerUserId
    WHERE BINARY LOWER(COALESCE(CAST(sr.status AS CHAR), '')) <> BINARY 'draft'
    ORDER BY COALESCE(sr.scheduledAt, ${requestCreatedAtSelect}) DESC
    LIMIT 120
  `);

  return {
    statuses: statusRows.map((row) => ({ ...row, count: num(row.count) })),
    services: serviceRows.map((row) => ({ ...row, count: num(row.count) })),
    providers: providerRows.map((row) => ({
      ...row,
      totalVisits: num(row.totalVisits),
      completedVisits: num(row.completedVisits),
    })),
    recentRequests: requestRows,
  };
}

async function getProviderDocuments(providerId) {
  await ensureAdminColumns();
  const [rows] = await db.query(
    `
    SELECT documentId, providerUserId, medical_certificate, nursing_license,
           id_card, cv_file, workplace_history, createdAt, updatedAt
    FROM provider_documents
    WHERE BINARY providerUserId = BINARY ?
    ORDER BY createdAt DESC
    `,
    [providerId],
  );
  return rows;
}

async function ensureFinanceTablesImpl() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_commission (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      specialization VARCHAR(100) NOT NULL,
      serviceType ENUM('doctor','nurse') NOT NULL,
      commission_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      UNIQUE KEY uq_admin_commission_service (specialization, serviceType)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_rates (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      providerId CHAR(36) NOT NULL,
      provider_id CHAR(36) NULL,
      specialization VARCHAR(100) NOT NULL,
      provider_hour_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      provider_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      admin_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      patient_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      rateAcceptanceStatus ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
      rateSetAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      rateAcceptedAt DATETIME NULL,
      rateRejectedAt DATETIME NULL,
      UNIQUE KEY uq_provider_rate (providerId, specialization)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_rate_approval (
      provider_id CHAR(36) NOT NULL,
      specialization VARCHAR(100) NOT NULL,
      admin_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (provider_id, specialization)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rate_approvals (
      provider_id CHAR(36) NOT NULL,
      admin_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const rateColumns = [
    ['provider_id', 'ALTER TABLE provider_rates ADD COLUMN provider_id CHAR(36) NULL'],
    ['provider_rate', 'ALTER TABLE provider_rates ADD COLUMN provider_rate DECIMAL(10,2) NOT NULL DEFAULT 0'],
    ['admin_rate', 'ALTER TABLE provider_rates ADD COLUMN admin_rate DECIMAL(10,2) NOT NULL DEFAULT 0'],
    ['patient_rate', 'ALTER TABLE provider_rates ADD COLUMN patient_rate DECIMAL(10,2) NOT NULL DEFAULT 0'],
    ['status', "ALTER TABLE provider_rates ADD COLUMN status VARCHAR(24) NOT NULL DEFAULT 'active'"],
    [
      'rateAcceptanceStatus',
      "ALTER TABLE provider_rates ADD COLUMN rateAcceptanceStatus ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending'",
    ],
    ['rateSetAt', 'ALTER TABLE provider_rates ADD COLUMN rateSetAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['rateAcceptedAt', 'ALTER TABLE provider_rates ADD COLUMN rateAcceptedAt DATETIME NULL'],
    ['rateRejectedAt', 'ALTER TABLE provider_rates ADD COLUMN rateRejectedAt DATETIME NULL'],
  ];
  for (const [column, sql] of rateColumns) {
    if (await hasColumn('provider_rates', column)) continue;
    try {
      await db.query(sql);
      cache.set(`provider_rates.${column}`, true);
    } catch (_) {}
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_wallet (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      total_income DECIMAL(10,2) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_wallet (
      providerId CHAR(36) NOT NULL PRIMARY KEY,
      total_earned DECIMAL(10,2) NOT NULL DEFAULT 0,
      pending_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      paid_amount DECIMAL(10,2) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS payout_requests (
      payoutId CHAR(36) NOT NULL PRIMARY KEY,
      providerId CHAR(36) NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      status ENUM('requested','approved','rejected','paid') NOT NULL DEFAULT 'requested',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS transaction_log (
      transactionId CHAR(36) NOT NULL PRIMARY KEY,
      providerId CHAR(36) NULL,
      patientId CHAR(36) NULL,
      total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      admin_share DECIMAL(10,2) NOT NULL DEFAULT 0,
      provider_share DECIMAL(10,2) NOT NULL DEFAULT 0,
      type ENUM('payment','payout') NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`INSERT IGNORE INTO admin_wallet (id, total_income) VALUES (1, 0)`);
  try {
    await db.query(
      `ALTER TABLE admin_commission ADD UNIQUE KEY uq_admin_commission_service (specialization, serviceType)`,
    );
  } catch (_) {}
  try {
    await db.query(
      `ALTER TABLE provider_rates ADD UNIQUE KEY uq_provider_rate (providerId, specialization)`,
    );
  } catch (_) {}

  if (await hasTable('payment')) {
    const additions = [
      ['provider_amount', 'ALTER TABLE payment ADD COLUMN provider_amount DECIMAL(10,2) NULL'],
      ['admin_amount', 'ALTER TABLE payment ADD COLUMN admin_amount DECIMAL(10,2) NULL'],
      ['final_amount', 'ALTER TABLE payment ADD COLUMN final_amount DECIMAL(10,2) NULL'],
      [
        'status',
        "ALTER TABLE payment ADD COLUMN status ENUM('pending','paid_to_admin','transferred_to_provider','refunded') DEFAULT 'pending'",
      ],
    ];
    for (const [column, sql] of additions) {
      if (await hasColumn('payment', column)) continue;
      try {
        await db.query(sql);
        cache.set(`payment.${column}`, true);
      } catch (_) {}
    }
  }

  const defaults = [
    ['Cardiology', 'doctor', 20],
    ['Neurology', 'doctor', 30],
    ['General Medicine', 'doctor', 15],
    ['Elderly Care', 'nurse', 10],
    ['Pediatrics Care', 'nurse', 6],
    ['Wound Care', 'nurse', 8],
    ['Home Nursing Care', 'nurse', 6],
  ];
  for (const row of defaults) {
    await db.query(
      `INSERT INTO admin_commission
         (specialization, serviceType, commission_amount)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      row,
    );
  }
}

async function ensureFinanceTables() {
  if (!financeTablesPromise) {
    financeTablesPromise = ensureFinanceTablesImpl().catch((error) => {
      financeTablesPromise = null;
      throw error;
    });
  }
  return financeTablesPromise;
}

async function syncFinanceLedger() {
  await ensureFinanceTables();
  if (!(await hasTable('payment'))) return;
  const [payments] = await db.query(`
    SELECT
      p.paymentId, p.requestId, p.patientUserId, p.providerUserId,
      COALESCE(p.final_amount, p.amount, 0) AS totalAmount,
      COALESCE(p.provider_amount, 0) AS currentProviderAmount,
      COALESCE(p.admin_amount, 0) AS currentAdminAmount,
      COALESCE(p.status, 'pending') AS escrowStatus,
      sr.serviceType AS requestServiceType,
      u.role AS providerRole,
      cp.specialization
    FROM payment p
    LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY p.requestId
    LEFT JOIN user u ON BINARY u.userId = BINARY p.providerUserId
    LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY p.providerUserId
    WHERE BINARY LOWER(CAST(p.paymentStatus AS CHAR)) = BINARY 'paid'
      AND (
        p.provider_amount IS NULL OR p.admin_amount IS NULL OR
        p.final_amount IS NULL OR
        BINARY COALESCE(CAST(p.status AS CHAR), 'pending') = BINARY 'pending'
      )
    ORDER BY p.createdAt ASC
    LIMIT 500
  `);

  for (const payment of payments) {
    const providerId = (payment.providerUserId || '').toString();
    const role = (payment.providerRole || '').toString().toLowerCase() === 'doctor'
      ? 'doctor'
      : 'nurse';
    const specialization =
      (payment.specialization || payment.requestServiceType || 'Home Nursing Care')
        .toString()
        .trim();
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[lockedPayment]] = await connection.query(
        `SELECT paymentStatus, status, amount, final_amount,
                provider_amount, admin_amount
         FROM payment
         WHERE BINARY paymentId = BINARY ?
         FOR UPDATE`,
        [payment.paymentId],
      );
      const stillPaid =
        (lockedPayment?.paymentStatus || '').toString().toLowerCase() === 'paid';
      const stillNeedsSync =
        lockedPayment &&
        (lockedPayment.provider_amount == null ||
          lockedPayment.admin_amount == null ||
          lockedPayment.final_amount == null ||
          (lockedPayment.status || 'pending').toString().toLowerCase() === 'pending');
      if (!stillPaid || !stillNeedsSync) {
        await connection.rollback();
        continue;
      }

      const total = Math.max(
        0,
        Number(lockedPayment.final_amount ?? lockedPayment.amount ?? 0),
      );
      const [[rateRow]] = await connection.query(
        `SELECT provider_hour_rate
         FROM provider_rates
         WHERE BINARY providerId = BINARY ?
         ORDER BY (rateAcceptanceStatus = 'accepted') DESC, id DESC
         LIMIT 1`,
        [providerId],
      );
      const [[commissionRow]] = await connection.query(
        `SELECT commission_amount
         FROM admin_commission
         WHERE CONVERT(specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci =
               CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
           AND BINARY CAST(serviceType AS CHAR) = BINARY ?
         ORDER BY id DESC
         LIMIT 1`,
        [specialization, role],
      );
      const commission = Math.max(
        0,
        Number(commissionRow?.commission_amount || 0),
      );
      let providerShare = Number(rateRow?.provider_hour_rate || 0);
      if (!Number.isFinite(providerShare) || providerShare <= 0) {
        providerShare = Math.max(0, total - commission);
      }
      if (providerShare > total) {
        providerShare = Math.max(0, total - commission);
      }
      const adminShare = Math.max(0, total - providerShare);

      await connection.query(
        `UPDATE payment
         SET provider_amount = ?, admin_amount = ?, final_amount = ?,
             status = 'paid_to_admin', updatedAt = NOW()
         WHERE BINARY paymentId = BINARY ?`,
        [providerShare, adminShare, total, payment.paymentId],
      );
      await connection.query(
        `INSERT INTO provider_wallet
           (providerId, total_earned, pending_amount, paid_amount)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           total_earned = total_earned + VALUES(total_earned),
           pending_amount = pending_amount + VALUES(pending_amount)`,
        [providerId, providerShare, providerShare],
      );
      await connection.query(
        `UPDATE admin_wallet SET total_income = total_income + ? WHERE id = 1`,
        [adminShare],
      );
      await connection.query(
        `INSERT IGNORE INTO transaction_log
         (transactionId, providerId, patientId, total_amount,
          admin_share, provider_share, type, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, 'payment', NOW())`,
        [
          payment.paymentId,
          providerId,
          payment.patientUserId,
          total,
          adminShare,
          providerShare,
        ],
      );
      await connection.commit();
    } catch (err) {
      try {
        await connection.rollback();
      } catch (_) {}
      throw err;
    } finally {
      connection.release();
    }
  }
}

async function syncProviderWalletForPayout(providerId) {
  const [earnedRows] = await db.query(
    `SELECT
       COALESCE(p.provider_amount, 0) AS providerAmount,
       COALESCE(p.final_amount, p.amount, 0) AS totalAmount,
       COALESCE(pr.provider_hour_rate, 0) AS configuredRate,
       COALESCE((
         SELECT pr2.provider_hour_rate FROM provider_rates pr2
         WHERE BINARY pr2.providerId = BINARY p.providerUserId
         ORDER BY (pr2.rateAcceptanceStatus = 'accepted') DESC, pr2.id DESC
         LIMIT 1
       ), 0) AS fallbackRate,
       COALESCE(ac.commission_amount, 0) AS commissionAmount
     FROM payment p
     JOIN servicerequest sr ON BINARY sr.requestId = BINARY p.requestId
     LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY p.providerUserId
     LEFT JOIN user u ON BINARY u.userId = BINARY p.providerUserId
     LEFT JOIN provider_rates pr
       ON BINARY pr.providerId = BINARY p.providerUserId
      AND CONVERT(pr.specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci =
          CONVERT(COALESCE(sr.serviceType, cp.specialization, 'Nursing Service') USING utf8mb4) COLLATE utf8mb4_unicode_ci
     LEFT JOIN admin_commission ac
       ON CONVERT(ac.specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci =
          CONVERT(COALESCE(sr.serviceType, cp.specialization, 'Nursing Service') USING utf8mb4) COLLATE utf8mb4_unicode_ci
      AND CONVERT(ac.serviceType USING utf8mb4) COLLATE utf8mb4_unicode_ci =
          CONVERT(COALESCE(u.role, 'nurse') USING utf8mb4) COLLATE utf8mb4_unicode_ci
     WHERE BINARY p.providerUserId = BINARY ?
       AND LOWER(CAST(p.paymentStatus AS CHAR)) = 'paid'
       AND LOWER(CAST(sr.status AS CHAR)) IN ('completed','complete','done','waiting_report')`,
    [providerId],
  );

  let calculatedEarned = 0;
  for (const row of earnedRows) {
    const providerAmount = Number(row.providerAmount || 0);
    const configuredRate = Number(row.configuredRate || 0);
    const fallbackRate = Number(row.fallbackRate || 0);
    const totalAmount = Number(row.totalAmount || 0);
    const commissionAmount = Number(row.commissionAmount || 0);
    // Provider share is the provider rate only; the admin commission the
    // patient paid on top of it is never part of provider earnings.
    let share = providerAmount > 0
      ? providerAmount
      : configuredRate > 0
        ? configuredRate
        : fallbackRate;
    if (share <= 0 && totalAmount > 0) {
      share = Math.max(0, totalAmount - commissionAmount);
    }
    if (totalAmount > 0 && share > totalAmount) {
      share = Math.max(0, totalAmount - commissionAmount);
    }
    calculatedEarned += Math.max(0, share);
  }

  const [[ledgerEarnedRow]] = await db.query(
    `SELECT COALESCE(SUM(provider_share), 0) AS earned
     FROM transaction_log
     WHERE BINARY providerId = BINARY ?
       AND type = 'payment'`,
    [providerId],
  );
  const [[paidRow]] = await db.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS paid
     FROM transaction_log
     WHERE BINARY providerId = BINARY ?
       AND type = 'payout'`,
    [providerId],
  );
  const [[existingWallet]] = await db.query(
    `SELECT COALESCE(total_earned, 0) AS totalEarned
     FROM provider_wallet
     WHERE BINARY providerId = BINARY ?
     LIMIT 1`,
    [providerId],
  );

  const totalEarned = Math.max(
    0,
    Number(ledgerEarnedRow?.earned || 0),
    calculatedEarned,
    Number(existingWallet?.totalEarned || 0),
  );
  const paidAmount = Math.max(0, Number(paidRow?.paid || 0));
  const pendingAmount = Math.max(0, totalEarned - paidAmount);

  await db.query(
    `INSERT INTO provider_wallet
       (providerId, total_earned, pending_amount, paid_amount)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_earned = VALUES(total_earned),
       pending_amount = VALUES(pending_amount),
       paid_amount = VALUES(paid_amount)`,
    [providerId, totalEarned, pendingAmount, paidAmount],
  );

  return { totalEarned, paidAmount, pendingAmount };
}

async function getFinanceData() {
  await syncFinanceLedger();

  const [[overview]] = await db.query(`
    SELECT
      COALESCE(SUM(COALESCE(final_amount, amount, 0)), 0) AS totalRevenue,
      COALESCE(SUM(CASE WHEN BINARY COALESCE(CAST(status AS CHAR), 'pending') = BINARY 'paid_to_admin'
        THEN COALESCE(provider_amount, 0) ELSE 0 END), 0) AS pendingEscrow,
      COALESCE(SUM(CASE WHEN BINARY COALESCE(CAST(status AS CHAR), 'pending') = BINARY 'transferred_to_provider'
        THEN COALESCE(provider_amount, 0) ELSE 0 END), 0) AS releasedToProviders,
      COALESCE(SUM(COALESCE(admin_amount, 0)), 0) AS platformProfit,
      COUNT(*) AS paymentCount
    FROM payment
    WHERE BINARY LOWER(CAST(paymentStatus AS CHAR)) = BINARY 'paid'
  `);
  const [[wallet]] = await db.query(
    `SELECT COALESCE(total_income, 0) AS totalIncome FROM admin_wallet WHERE id = 1`,
  );
  const [pricing] = await db.query(`
    SELECT
      pr.id AS rateId,
      pr.providerId,
      COALESCE(u.fullName, 'Unassigned Provider') AS providerName,
      COALESCE(u.role, ac.serviceType, 'nurse') AS providerRole,
      COALESCE(cp.experienceYears, 0) AS experienceYears,
      COALESCE(cp.overallRating, 0) AS performanceRating,
      pr.specialization,
      pr.provider_hour_rate AS providerRate,
      COALESCE(pr.rateAcceptanceStatus, 'pending') AS rateAcceptanceStatus,
      pr.rateSetAt,
      pr.rateAcceptedAt,
      pr.rateRejectedAt,
      COALESCE(ac.commission_amount, 0) AS adminCommission,
      (pr.provider_hour_rate + COALESCE(ac.commission_amount, 0)) AS patientPrice
    FROM provider_rates pr
    LEFT JOIN user u ON BINARY u.userId = BINARY pr.providerId
    LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY pr.providerId
    LEFT JOIN admin_commission ac
      ON CONVERT(ac.specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci =
         CONVERT(pr.specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci
     AND BINARY CAST(ac.serviceType AS CHAR) =
         CASE WHEN BINARY CAST(u.role AS CHAR) = BINARY 'doctor' THEN BINARY 'doctor' ELSE BINARY 'nurse' END
    ORDER BY providerRole, pr.specialization, providerName
  `);
  const [transactions] = await db.query(`
    SELECT
      p.paymentId, p.requestId, p.patientUserId, p.providerUserId,
      pu.fullName AS patientName,
      pr.fullName AS providerName,
      COALESCE(p.final_amount, p.amount, 0) AS totalAmount,
      COALESCE(p.admin_amount, 0) AS adminShare,
      COALESCE(p.provider_amount, 0) AS providerShare,
      p.paymentStatus,
      COALESCE(p.status, 'pending') AS escrowStatus,
      p.createdAt
    FROM payment p
    LEFT JOIN user pu ON BINARY pu.userId = BINARY p.patientUserId
    LEFT JOIN user pr ON BINARY pr.userId = BINARY p.providerUserId
    ORDER BY p.createdAt DESC
    LIMIT 120
  `);
  const [payouts] = await db.query(`
    SELECT
      po.payoutId, po.providerId, po.amount, po.status, po.createdAt,
      u.fullName AS providerName,
      u.role AS providerRole,
      cp.specialization,
      COALESCE(w.total_earned, 0) AS totalEarned,
      COALESCE(w.pending_amount, 0) AS pendingAmount,
      COALESCE(w.paid_amount, 0) AS paidAmount,
      COUNT(sr.requestId) AS completedSessions,
      COALESCE((
        SELECT pr2.provider_hour_rate FROM provider_rates pr2
        WHERE BINARY pr2.providerId = BINARY po.providerId
        ORDER BY (pr2.rateAcceptanceStatus = 'accepted') DESC, pr2.id DESC
        LIMIT 1
      ), 0) AS providerRate,
      COALESCE((
        SELECT SUM(COALESCE(p2.provider_amount, 0)) FROM payment p2
        WHERE BINARY p2.providerUserId = BINARY po.providerId
          AND LOWER(CAST(p2.paymentStatus AS CHAR)) = 'paid'
      ), 0) AS providerEarnedTotal,
      COALESCE((
        SELECT SUM(COALESCE(p2.admin_amount, 0)) FROM payment p2
        WHERE BINARY p2.providerUserId = BINARY po.providerId
          AND LOWER(CAST(p2.paymentStatus AS CHAR)) = 'paid'
      ), 0) AS adminEarnedTotal,
      COALESCE((
        SELECT ac.commission_amount FROM admin_commission ac
        WHERE CONVERT(ac.specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci =
              CONVERT(COALESCE(cp.specialization, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci
          AND BINARY CAST(ac.serviceType AS CHAR) = BINARY LOWER(CAST(u.role AS CHAR))
        ORDER BY ac.id DESC
        LIMIT 1
      ), 0) AS commissionPerSession
    FROM payout_requests po
    LEFT JOIN user u ON BINARY u.userId = BINARY po.providerId
    LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY po.providerId
    LEFT JOIN provider_wallet w ON BINARY w.providerId = BINARY po.providerId
    LEFT JOIN servicerequest sr
      ON BINARY sr.providerUserId = BINARY po.providerId
     AND BINARY LOWER(CAST(sr.status AS CHAR)) IN (BINARY 'completed', BINARY 'done')
    GROUP BY po.payoutId, po.providerId, po.amount, po.status, po.createdAt,
      u.fullName, u.role, cp.specialization, w.total_earned, w.pending_amount, w.paid_amount
    ORDER BY CASE BINARY CAST(po.status AS CHAR)
      WHEN BINARY 'requested' THEN 1
      WHEN BINARY 'approved' THEN 2
      WHEN BINARY 'paid' THEN 3
      WHEN BINARY 'rejected' THEN 4
      ELSE 5
    END, po.createdAt DESC
  `);
  // Canonical payout figures: the provider is paid their rate only; the admin
  // commission (paid by the patient on top of the rate) is pro-rated from the
  // recorded payment splits, falling back to the configured commission.
  const payoutRows = payouts.map((po) => {
    const round2 = (v) => Math.round(v * 100) / 100;
    const providerAmount = round2(Math.max(0, Number(po.amount || 0)));
    const rate = Number(po.providerRate || 0);
    const earned = Number(po.providerEarnedTotal || 0);
    const adminEarned = Number(po.adminEarnedTotal || 0);
    const sessionsCovered = rate > 0
      ? Math.max(1, Math.round(providerAmount / rate))
      : Number(po.completedSessions || 0);
    let adminAmount = 0;
    if (earned > 0 && adminEarned > 0) {
      adminAmount = adminEarned * Math.min(1, providerAmount / earned);
    } else {
      adminAmount = Number(po.commissionPerSession || 0) * sessionsCovered;
    }
    adminAmount = round2(Math.max(0, adminAmount));
    return {
      ...po,
      providerAmount,
      adminAmount,
      patientPaid: round2(providerAmount + adminAmount),
      providerRate: rate,
      sessionsCovered,
    };
  });
  const [wallets] = await db.query(`
    SELECT
      w.providerId,
      u.fullName AS providerName,
      u.role AS providerRole,
      cp.specialization,
      w.total_earned AS totalEarned,
      w.pending_amount AS pendingAmount,
      w.paid_amount AS paidAmount
    FROM provider_wallet w
    LEFT JOIN user u ON BINARY u.userId = BINARY w.providerId
    LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY w.providerId
    ORDER BY w.pending_amount DESC, w.total_earned DESC
  `);
  const [topServices] = await db.query(`
    SELECT
      COALESCE(
        CONVERT(sr.serviceType USING utf8mb4) COLLATE utf8mb4_unicode_ci,
        CONVERT(cp.specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci,
        CONVERT('Service' USING utf8mb4) COLLATE utf8mb4_unicode_ci
      ) AS serviceType,
      COUNT(*) AS completedRequests,
      COALESCE(SUM(COALESCE(p.final_amount, p.amount, 0)), 0) AS revenue
    FROM servicerequest sr
    LEFT JOIN payment p ON BINARY p.requestId = BINARY sr.requestId
    LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY sr.providerUserId
    WHERE BINARY LOWER(CAST(sr.status AS CHAR)) IN (BINARY 'completed', BINARY 'done')
    GROUP BY COALESCE(
      CONVERT(sr.serviceType USING utf8mb4) COLLATE utf8mb4_unicode_ci,
      CONVERT(cp.specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci,
      CONVERT('Service' USING utf8mb4) COLLATE utf8mb4_unicode_ci
    )
    ORDER BY revenue DESC, completedRequests DESC
    LIMIT 8
  `);

  return {
    overview: {
      totalRevenue: Number(overview?.totalRevenue || 0),
      pendingEscrow: Number(overview?.pendingEscrow || 0),
      releasedToProviders: Number(overview?.releasedToProviders || 0),
      platformProfit: Number(overview?.platformProfit || wallet?.totalIncome || 0),
      paymentCount: num(overview?.paymentCount),
    },
    pricing,
    transactions,
    payouts: payoutRows,
    wallets,
    topServices,
    flow: [
      { step: 'Patient pays', description: 'Final patient price is collected by CareLink admin.' },
      { step: 'Admin holds funds', description: 'Payment stays in escrow until the visit is completed.' },
      { step: 'Split payment', description: 'Provider earning and admin commission are calculated from DB rates.' },
      { step: 'Release payout', description: 'Admin approves payout and provider wallet is updated.' },
    ],
  };
}

function bookingReviewStatusFrom(row) {
  const status = (row.status || '').toString().trim().toLowerCase();
  const adminStatus = (row.adminReviewStatus || '').toString().trim().toLowerCase();
  if (adminStatus) return adminStatus;
  if (['under_review', 'dispute', 'no_show'].includes(status)) return status;
  if (['pending', 'pending_provider_approval', 'pending_payment', 'payment_pending'].includes(status)) {
    return 'request_expired';
  }
  if (['confirmed', 'upcoming', 'accepted'].includes(status)) return 'missed_appointment';
  if (['in_progress', 'waiting_report'].includes(status)) return 'waiting_completion';
  return '';
}

function bookingReviewReason(reviewStatus) {
  switch (reviewStatus) {
    case 'request_expired':
      return 'The patient paid or requested a booking, but the nurse did not approve before the appointment time.';
    case 'missed_appointment':
    case 'no_show':
      return 'The confirmed appointment time passed without cancellation or completion.';
    case 'waiting_completion':
      return 'The visit was active or waiting for a report, but completion was not confirmed.';
    case 'dispute':
      return 'The case needs an admin decision because the attendance or service outcome is unclear.';
    case 'under_review':
      return 'The booking is already held for admin review.';
    default:
      return 'This booking needs an admin decision.';
  }
}

function bookingReviewNotes(reviewStatus) {
  switch (reviewStatus) {
    case 'request_expired':
      return 'Expected decision: full refund if the nurse did not approve or attend.';
    case 'missed_appointment':
    case 'no_show':
      return 'Do not treat this as patient cancellation. Keep funds under review until admin decides.';
    case 'waiting_completion':
      return 'If care was delivered, confirm completion. Otherwise move to dispute or refund.';
    case 'dispute':
      return 'Review nurse notes, attendance evidence, and payment status before deciding.';
    default:
      return 'Admin review state is tracked separately from patient cancellation.';
  }
}

function bookingReviewDecisionMessage(decision) {
  switch (decision) {
    case 'confirm_completed':
      return {
        title: 'Service marked as completed',
        body: 'Admin reviewed your nurse booking and confirmed that the service was completed.',
      };
    case 'full_refund':
      return {
        title: 'Refund decision has been made',
        body: 'Admin reviewed your nurse booking and approved a full refund to the patient.',
      };
    case 'partial_refund':
      return {
        title: 'Refund decision has been made',
        body: 'Admin reviewed your nurse booking and approved a partial refund.',
      };
    case 'deny_refund':
      return {
        title: 'Refund request was denied',
        body: 'Admin reviewed your nurse booking and denied the refund request.',
      };
    case 'mark_dispute':
      return {
        title: 'Booking moved to dispute',
        body: 'Admin reviewed your nurse booking and moved it to dispute for further review.',
      };
    default:
      return {
        title: 'Admin reviewed your booking',
        body: 'Admin reviewed your nurse booking and updated the review decision.',
      };
  }
}

async function applyReviewPaymentSplit({ payment, booking, providerShare, adminShare, finalAmount, paymentStatus = 'paid' }) {
  if (!payment?.paymentId) return null;
  const safeProviderShare = Number(Math.max(0, providerShare).toFixed(2));
  const safeAdminShare = Number(Math.max(0, adminShare).toFixed(2));
  const safeFinalAmount = Number(Math.max(0, finalAmount).toFixed(2));
  await db.query(
    `UPDATE payment
     SET paymentStatus = ?,
         status = ?,
         provider_amount = ?,
         admin_amount = ?,
         final_amount = ?,
         updatedAt = NOW()
     WHERE BINARY paymentId = BINARY ?`,
    [
      paymentStatus,
      paymentStatus === 'refunded' ? 'refunded' : 'paid_to_admin',
      safeProviderShare,
      safeAdminShare,
      safeFinalAmount,
      payment.paymentId,
    ],
  );
  await adjustFinanceLedgerForReview({
    providerId: payment.providerUserId || booking.providerUserId,
    oldProviderAmount: payment.provider_amount,
    newProviderAmount: safeProviderShare,
    oldAdminAmount: payment.admin_amount,
    newAdminAmount: safeAdminShare,
  });
  return {
    providerShare: safeProviderShare,
    adminShare: safeAdminShare,
    retainedAmount: safeFinalAmount,
  };
}

async function getBookingReviewItems() {
  await ensureAdminColumns();
  const hasProfileImageUrl = await hasColumn('user', 'profileImageUrl');
  const [rows] = await db.query(`
    SELECT
      sr.requestId,
      sr.patientUserId,
      sr.providerUserId,
      sr.serviceType,
      sr.status,
      sr.scheduledAt,
      sr.adminReviewStatus,
      sr.adminReviewDecision,
      sr.adminReviewNotes,
      sr.adminReviewedAt,
      pu.fullName AS patientName,
      ${hasProfileImageUrl ? 'pu.profileImageUrl' : 'NULL'} AS profileImageUrl,
      pr.fullName AS providerName,
      pr.role AS providerRole,
      COALESCE(p.paymentId, '') AS paymentId,
      COALESCE(p.paymentStatus, sr.paymentStatus, 'pending') AS paymentStatus,
      COALESCE(p.final_amount, p.amount, 0) AS paidAmount,
      COALESCE(p.status, 'pending') AS escrowStatus
    FROM servicerequest sr
    JOIN user pr ON BINARY pr.userId = BINARY sr.providerUserId
    LEFT JOIN user pu ON BINARY pu.userId = BINARY sr.patientUserId
    LEFT JOIN payment p ON BINARY p.requestId = BINARY sr.requestId
    WHERE BINARY CAST(pr.role AS CHAR) = BINARY 'nurse'
      AND sr.scheduledAt IS NOT NULL
      AND sr.scheduledAt < NOW()
      AND BINARY LOWER(COALESCE(CAST(sr.status AS CHAR), '')) NOT IN
        (BINARY 'completed', BINARY 'done', BINARY 'cancelled', BINARY 'canceled', BINARY 'draft')
      AND (
        sr.adminReviewDecision IS NULL
        OR BINARY CAST(sr.adminReviewDecision AS CHAR) = BINARY ''
        OR BINARY CAST(sr.adminReviewStatus AS CHAR) IN (BINARY 'under_review', BINARY 'dispute')
      )
    ORDER BY sr.scheduledAt DESC
    LIMIT 200
  `);

  return rows
    .map((row) => {
      const reviewStatus = bookingReviewStatusFrom(row);
      if (!reviewStatus) return null;
      return {
        id: row.requestId,
        requestId: row.requestId,
        patientUserId: row.patientUserId,
        providerUserId: row.providerUserId,
        patientName: row.patientName || 'Patient',
        profileImageUrl: row.profileImageUrl || null,
        providerName: row.providerName || 'Nurse',
        providerRole: 'nurse',
        serviceType: row.serviceType || 'Nursing Service',
        scheduledAt: row.scheduledAt,
        amount: Number(row.paidAmount || 0),
        status: reviewStatus,
        originalStatus: row.status,
        paymentStatus: row.paymentStatus || 'pending',
        escrowStatus: row.escrowStatus || 'pending',
        decision: row.adminReviewDecision || '',
        reason: bookingReviewReason(reviewStatus),
        systemNotes: row.adminReviewNotes || bookingReviewNotes(reviewStatus),
      };
    })
    .filter(Boolean);
}

async function applyBookingReviewDecision(requestId, body = {}) {
  await ensureAdminColumns();
  await ensureFinanceTables();
  const decision = (body.decision || '').toString().trim().toLowerCase();
  const notes = (body.notes || '').toString().trim();
  const allowed = new Set([
    'confirm_completed',
    'full_refund',
    'partial_refund',
    'deny_refund',
    'mark_dispute',
  ]);
  if (!allowed.has(decision)) {
    const e = new Error('decision must be confirm_completed, full_refund, partial_refund, deny_refund, or mark_dispute');
    e.status = 400;
    throw e;
  }

  const [[booking]] = await db.query(
    `SELECT sr.requestId, sr.patientUserId, sr.providerUserId, sr.status, sr.scheduledAt,
            sr.adminReviewDecision, pr.role AS providerRole
     FROM servicerequest sr
     JOIN user pr ON BINARY pr.userId = BINARY sr.providerUserId
     WHERE BINARY sr.requestId = BINARY ?
     LIMIT 1`,
    [requestId],
  );
  if (!booking) {
    const e = new Error('Booking not found');
    e.status = 404;
    throw e;
  }
  if ((booking.providerRole || '').toString().toLowerCase() !== 'nurse') {
    const e = new Error('Booking review is available for nurse bookings only');
    e.status = 403;
    throw e;
  }

  const [[payment]] = await db.query(
    `SELECT paymentId, providerUserId, amount, final_amount, provider_amount, admin_amount, paymentStatus, status
     FROM payment
     WHERE BINARY requestId = BINARY ?
     ORDER BY createdAt DESC
     LIMIT 1`,
    [requestId],
  );
  const paidAmount = Math.max(0, Number(payment?.final_amount || payment?.amount || 0));
  let reviewStatus = 'under_review';
  let paymentSummary = null;

  if (decision === 'confirm_completed') {
    paymentSummary = await applyReviewPaymentSplit({
      payment,
      booking,
      providerShare: paidAmount * 0.9,
      adminShare: paidAmount * 0.1,
      finalAmount: paidAmount,
    });
    await db.query(
      `UPDATE servicerequest
       SET status = 'completed',
           completedAt = COALESCE(completedAt, NOW()),
           adminReviewStatus = 'resolved',
           adminReviewDecision = ?,
           adminReviewNotes = ?,
           adminReviewedAt = NOW()
       WHERE BINARY requestId = BINARY ?`,
      [decision, notes || 'Admin confirmed that the nurse completed the service.', requestId],
    );
    reviewStatus = 'resolved';
  } else if (decision === 'full_refund') {
    if (payment?.paymentId) {
      await applyReviewPaymentSplit({
        payment,
        booking,
        providerShare: 0,
        adminShare: 0,
        finalAmount: 0,
        paymentStatus: 'refunded',
      });
      paymentSummary = { refundAmount: paidAmount, retainedAmount: 0 };
    }
    await db.query(
      `UPDATE servicerequest
       SET adminReviewStatus = 'resolved',
           adminReviewDecision = ?,
           adminReviewNotes = ?,
           adminReviewedAt = NOW()
       WHERE BINARY requestId = BINARY ?`,
      [decision, notes || 'Admin approved a full refund. This is not a patient cancellation.', requestId],
    );
    reviewStatus = 'resolved';
  } else if (decision === 'partial_refund') {
    const requestedRefund = Number(body.refundAmount);
    const refundAmount = Number.isFinite(requestedRefund)
      ? Math.min(Math.max(0, requestedRefund), paidAmount)
      : Number((paidAmount * 0.8).toFixed(2));
    const retained = Math.max(0, paidAmount - refundAmount);
    const providerShare = Number((paidAmount * 0.1).toFixed(2));
    const adminShare = Number((paidAmount * 0.1).toFixed(2));
    if (payment?.paymentId) {
      await applyReviewPaymentSplit({
        payment,
        booking,
        providerShare,
        adminShare,
        finalAmount: retained,
        paymentStatus: 'refunded',
      });
      paymentSummary = { refundAmount, retainedAmount: retained, providerShare, adminShare };
    }
    await db.query(
      `UPDATE servicerequest
       SET adminReviewStatus = 'resolved',
           adminReviewDecision = ?,
           adminReviewNotes = ?,
           adminReviewedAt = NOW()
       WHERE BINARY requestId = BINARY ?`,
      [decision, notes || `Admin approved a partial refund of ${refundAmount}.`, requestId],
    );
    reviewStatus = 'resolved';
  } else if (decision === 'deny_refund') {
    paymentSummary = await applyReviewPaymentSplit({
      payment,
      booking,
      providerShare: paidAmount * 0.9,
      adminShare: paidAmount * 0.1,
      finalAmount: paidAmount,
    });
    await db.query(
      `UPDATE servicerequest
       SET adminReviewStatus = 'resolved',
           adminReviewDecision = ?,
           adminReviewNotes = ?,
           adminReviewedAt = NOW()
       WHERE BINARY requestId = BINARY ?`,
      [decision, notes || 'Admin denied refund because patient no-show or no valid refund reason was confirmed.', requestId],
    );
    reviewStatus = 'resolved';
  } else if (decision === 'mark_dispute') {
    await db.query(
      `UPDATE servicerequest
       SET status = 'under_review',
           adminReviewStatus = 'dispute',
           adminReviewDecision = ?,
           adminReviewNotes = ?,
           adminReviewedAt = NOW()
       WHERE BINARY requestId = BINARY ?`,
      [decision, notes || 'Admin moved this nurse booking to dispute review.', requestId],
    );
    reviewStatus = 'dispute';
  }

  try {
    if (booking.providerUserId) {
      const message = bookingReviewDecisionMessage(decision);
      await insertNotification({
        userId: booking.providerUserId,
        type: 'booking_review',
        title: message.title,
        body: message.body,
        relatedRequestId: requestId,
      });
    }
  } catch (_) {}

  return { success: true, requestId, decision, reviewStatus, payment: paymentSummary };
}

async function adjustFinanceLedgerForReview({
  providerId,
  oldProviderAmount,
  newProviderAmount,
  oldAdminAmount,
  newAdminAmount,
}) {
  const providerDelta = Number(newProviderAmount || 0) - Number(oldProviderAmount || 0);
  const adminDelta = Number(newAdminAmount || 0) - Number(oldAdminAmount || 0);
  if (providerId && Math.abs(providerDelta) > 0.001) {
    await db.query(
      `INSERT INTO provider_wallet (providerId, total_earned, pending_amount, paid_amount)
       VALUES (?, GREATEST(0, ?), GREATEST(0, ?), 0)
       ON DUPLICATE KEY UPDATE
         total_earned = GREATEST(0, total_earned + ?),
         pending_amount = GREATEST(0, pending_amount + ?)`,
      [
        providerId,
        Math.max(0, providerDelta),
        Math.max(0, providerDelta),
        providerDelta,
        providerDelta,
      ],
    );
  }
  if (Math.abs(adminDelta) > 0.001) {
    await db.query(
      `INSERT INTO admin_wallet (id, total_income)
       VALUES (1, GREATEST(0, ?))
       ON DUPLICATE KEY UPDATE
         total_income = GREATEST(0, total_income + ?)`,
      [Math.max(0, adminDelta), adminDelta],
    );
  }
}

async function applyRefundRequestDecision(refundRequestId, body = {}) {
  await ensureRefundRequestsTable();
  await ensureFinanceTables();
  const decision = (body.decision || '').toString().trim().toLowerCase();
  const adminNote = (body.adminNote || body.notes || '').toString().trim();
  const adminId = (body.adminId || body.reviewedByAdminId || '').toString().trim();
  if (!['approved', 'rejected'].includes(decision)) {
    const error = new Error('decision must be approved or rejected');
    error.status = 400;
    throw error;
  }

  const connection = await db.getConnection();
  let walletAdjustment = null;
  let patientId = '';
  let bookingId = '';
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT rr.*, sr.providerUserId,
              p.provider_amount AS oldProviderAmount,
              p.admin_amount AS oldAdminAmount
       FROM refund_requests rr
       LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY rr.bookingId
       LEFT JOIN payment p ON BINARY p.paymentId = BINARY rr.paymentId
       WHERE BINARY rr.id = BINARY ?
       FOR UPDATE`,
      [refundRequestId],
    );
    if (!rows.length) {
      const error = new Error('Refund request not found');
      error.status = 404;
      throw error;
    }
    const request = rows[0];
    patientId = request.patientId;
    bookingId = request.bookingId;
    if (request.status !== 'pending') {
      const error = new Error(`Refund request is already ${request.status}`);
      error.status = 409;
      throw error;
    }

    if (decision === 'rejected') {
      await connection.query(
        `UPDATE refund_requests
         SET status = 'rejected', adminNote = ?, reviewedAt = NOW(),
             reviewedByAdminId = ?
         WHERE BINARY id = BINARY ?`,
        [adminNote || 'Refund request rejected by admin.', adminId || null, refundRequestId],
      );
    } else {
      if (!request.paymentId) {
        const error = new Error('Refund request has no payment to process');
        error.status = 409;
        throw error;
      }
      await connection.query(
        `UPDATE payment
         SET paymentStatus = 'refunded', status = 'refunded',
             final_amount = ?, provider_amount = ?, admin_amount = ?, updatedAt = NOW()
         WHERE BINARY paymentId = BINARY ?`,
        [request.totalPaid, request.providerCompensation, request.platformFee, request.paymentId],
      );
      await connection.query(
        `UPDATE servicerequest SET paymentStatus = 'refunded'
         WHERE BINARY requestId = BINARY ?`,
        [request.bookingId],
      );
      await connection.query(
        `UPDATE refund_requests
         SET status = 'processed', adminNote = ?, reviewedAt = NOW(),
             processedAt = NOW(), reviewedByAdminId = ?
         WHERE BINARY id = BINARY ?`,
        [adminNote || 'Refund approved and processed by admin.', adminId || null, refundRequestId],
      );
      await connection.query(
        `INSERT INTO transaction_log
           (transactionId, providerId, patientId, total_amount,
            admin_share, provider_share, type, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, 'payment', NOW())
         ON DUPLICATE KEY UPDATE admin_share = VALUES(admin_share),
           provider_share = VALUES(provider_share), total_amount = VALUES(total_amount)`,
        [request.paymentId, request.providerUserId, request.patientId,
          request.totalPaid, request.platformFee, request.providerCompensation],
      );
      walletAdjustment = {
        providerId: request.providerUserId,
        oldProviderAmount: request.oldProviderAmount,
        newProviderAmount: request.providerCompensation,
        oldAdminAmount: request.oldAdminAmount,
        newAdminAmount: request.platformFee,
      };
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (walletAdjustment) await adjustFinanceLedgerForReview(walletAdjustment);
  try {
    await insertNotification({
      userId: patientId,
      type: 'refund_request',
      title: decision === 'approved' ? 'Refund approved' : 'Refund rejected',
      body: adminNote || (decision === 'approved'
        ? 'Your refund request was approved and processed.'
        : 'Your refund request was rejected.'),
      relatedRequestId: bookingId,
    });
  } catch (_) {}
  return { success: true, id: refundRequestId, decision,
    status: decision === 'approved' ? 'processed' : 'rejected' };
}

async function upsertFinancePricing(body) {
  await ensureAdminColumns();
  await ensureFinanceTables();
  const providerId = (body.providerId || '').toString().trim();
  const specialization = (body.specialization || '').toString().trim();
  const serviceType = (body.serviceType || '').toString().trim().toLowerCase();
  const providerRate = Number(body.providerRate);
  const commissionPercent = Number(body.adminCommissionPercent ?? 20);
  const extraCommission = Number(
    body.adminCommissionExtra ?? body.extraAdminCommission ?? 0,
  );

  if (!specialization || !['doctor', 'nurse'].includes(serviceType)) {
    const e = new Error('specialization and serviceType doctor/nurse are required');
    e.status = 400;
    throw e;
  }
  if (!Number.isFinite(providerRate) || providerRate < 0) {
    const e = new Error('providerRate must be a valid positive number');
    e.status = 400;
    throw e;
  }
  if (!Number.isFinite(commissionPercent) || commissionPercent < 20) {
    const e = new Error('adminCommissionPercent must be at least 20');
    e.status = 400;
    throw e;
  }
  if (!Number.isFinite(extraCommission) || extraCommission < 0) {
    const e = new Error('adminCommissionExtra must be a valid positive number');
    e.status = 400;
    throw e;
  }
  const commission =
    body.adminCommissionPercent == null
      ? Math.round(((providerRate * 0.2) + extraCommission) * 100) / 100
      : Math.round(providerRate * (commissionPercent / 100) * 100) / 100;
  const patientRate = Math.round((providerRate + commission) * 100) / 100;

  const [[existingCommission]] = await db.query(
    `SELECT id FROM admin_commission
     WHERE CONVERT(specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci =
           CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
       AND BINARY CAST(serviceType AS CHAR) = BINARY ?
     ORDER BY id DESC
     LIMIT 1`,
    [specialization, serviceType],
  );
  if (existingCommission) {
    await db.query(
      `UPDATE admin_commission SET commission_amount = ? WHERE id = ?`,
      [commission, existingCommission.id],
    );
  } else {
    await db.query(
      `INSERT INTO admin_commission (specialization, serviceType, commission_amount)
       VALUES (?, ?, ?)`,
      [specialization, serviceType, commission],
    );
  }
  if (providerId) {
    const [[existingRate]] = await db.query(
      `SELECT id FROM provider_rates
       WHERE BINARY providerId = BINARY ?
         AND CONVERT(specialization USING utf8mb4) COLLATE utf8mb4_unicode_ci =
             CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci
       ORDER BY id DESC
       LIMIT 1`,
      [providerId, specialization],
    );
    if (existingRate) {
      await db.query(
        `UPDATE provider_rates
         SET provider_hour_rate = ?,
             provider_rate = ?,
             admin_rate = ?,
             patient_rate = ?,
             provider_id = ?,
             status = 'active',
             rateAcceptanceStatus = 'pending',
             rateSetAt = NOW(),
             rateAcceptedAt = NULL,
             rateRejectedAt = NULL
         WHERE id = ?`,
        [providerRate, providerRate, commission, patientRate, providerId, existingRate.id],
      );
    } else {
      await db.query(
        `INSERT INTO provider_rates
         (providerId, provider_id, specialization, provider_hour_rate,
          provider_rate, admin_rate, patient_rate, status, rateAcceptanceStatus, rateSetAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'pending', NOW())`,
        [
          providerId,
          providerId,
          specialization,
          providerRate,
          providerRate,
          commission,
          patientRate,
        ],
      );
    }
    try {
      await insertNotification({
        userId: providerId,
        type: 'system',
        title: 'Hourly rate set',
        body: `Admin set your ${specialization} hourly rate to ${providerRate} ILS. Please accept it before starting work.`,
      });
    } catch (_) {}
    await db.query(
      `INSERT INTO provider_rate_approval (provider_id, specialization, admin_rate, status)
       VALUES (?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE
         admin_rate = VALUES(admin_rate),
         status = 'pending',
         updated_at = NOW()`,
      [providerId, specialization, providerRate],
    );
    await db.query(
      `INSERT INTO rate_approvals (provider_id, admin_rate, status)
       VALUES (?, ?, 'pending')
       ON DUPLICATE KEY UPDATE
         admin_rate = VALUES(admin_rate),
         status = 'pending',
         updated_at = NOW()`,
      [providerId, providerRate],
    );
    await db.query(
      `UPDATE careprovider
       SET is_rate_approved = 0,
           hourly_rate = ?,
           status = 'inactive'
       WHERE BINARY userId = BINARY ?`,
      [providerRate, providerId],
    );
    await db.query('UPDATE user SET isActive = 0 WHERE BINARY userId = BINARY ?', [
      providerId,
    ]);
  }
  return { success: true };
}

async function updatePayoutStatus(payoutId, action) {
  await syncFinanceLedger();
  const normalized = action === 'approve' ? 'paid' : action === 'reject' ? 'rejected' : '';
  if (!normalized) {
    const e = new Error('action must be approve or reject');
    e.status = 400;
    throw e;
  }
  const [rows] = await db.query(
    `SELECT payoutId, providerId, amount, status
     FROM payout_requests
     WHERE BINARY payoutId = BINARY ?
     LIMIT 1`,
    [payoutId],
  );
  if (!rows.length) {
    const e = new Error('Payout request not found');
    e.status = 404;
    throw e;
  }
  const payout = rows[0];
  if (!['requested', 'approved'].includes((payout.status || '').toLowerCase())) {
    const e = new Error('Payout is already closed');
    e.status = 409;
    throw e;
  }

  if (normalized === 'rejected') {
    await db.query(
      `UPDATE payout_requests SET status = 'rejected' WHERE BINARY payoutId = BINARY ?`,
      [payoutId],
    );
    return { success: true, status: 'rejected' };
  }

  const amount = Math.max(0, Number(payout.amount || 0));
  await syncProviderWalletForPayout(payout.providerId);
  const [[wallet]] = await db.query(
    `SELECT pending_amount FROM provider_wallet WHERE BINARY providerId = BINARY ?`,
    [payout.providerId],
  );
  if (Number(wallet?.pending_amount || 0) + 0.001 < amount) {
    await db.query(
      `INSERT INTO provider_wallet
         (providerId, total_earned, pending_amount, paid_amount)
       VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         total_earned = GREATEST(total_earned, paid_amount + ?),
         pending_amount = GREATEST(pending_amount, ?)`,
      [payout.providerId, amount, amount, amount, amount],
    );
  }

  await db.query(
    `UPDATE payout_requests SET status = 'paid' WHERE BINARY payoutId = BINARY ?`,
    [payoutId],
  );
  await db.query(
    `UPDATE provider_wallet
     SET pending_amount = GREATEST(0, pending_amount - ?),
         paid_amount = paid_amount + ?
     WHERE BINARY providerId = BINARY ?`,
    [amount, amount, payout.providerId],
  );
  await db.query(
    `INSERT IGNORE INTO transaction_log
     (transactionId, providerId, patientId, total_amount, admin_share, provider_share, type, createdAt)
     VALUES (?, ?, NULL, ?, 0, ?, 'payout', NOW())`,
    [payoutId, payout.providerId, amount, amount],
  );
  await db.query(
    `UPDATE payment
     SET status = 'transferred_to_provider', updatedAt = NOW()
     WHERE BINARY providerUserId = BINARY ?
       AND BINARY CAST(status AS CHAR) = BINARY 'paid_to_admin'
     ORDER BY createdAt ASC
     LIMIT 100`,
    [payout.providerId],
  );
  return { success: true, status: 'paid' };
}

router.get('/dashboard', async (req, res) => {
  try {
    await ensureAdminColumns();
    const [metrics, requests, users, ratings, performance, finance, bookingReview] = await Promise.all([
      getMetrics(),
      getRegistrationRequests(),
      getUsers(req.query.role?.toString() || 'all'),
      getRatings(),
      getPerformance(),
      getFinanceData(),
      getBookingReviewItems(),
    ]);
    res.json({ metrics, requests, users, ratings, performance, finance, bookingReview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/booking-review', async (req, res) => {
  try {
    res.json(await getBookingReviewItems());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/booking-review/:requestId/decision', async (req, res) => {
  try {
    res.json(await applyBookingReviewDecision(req.params.requestId, req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/refund-requests', async (req, res) => {
  try {
    res.json(await listRefundRequests((req.query.status || 'all').toString()));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/refund-requests/:refundRequestId/decision', async (req, res) => {
  try {
    res.json(await applyRefundRequestDecision(req.params.refundRequestId, req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/finance', async (req, res) => {
  try {
    res.json(await getFinanceData());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/finance/pricing', async (req, res) => {
  try {
    res.json(await upsertFinancePricing(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/finance/payouts/:payoutId/:action', async (req, res) => {
  try {
    res.json(await updatePayoutStatus(req.params.payoutId, req.params.action));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/providers/:providerId/certifications', async (req, res) => {
  try {
    await ensureAdminColumns();
    res.json(await getCertifications(req.params.providerId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/:providerId/documents', async (req, res) => {
  try {
    await ensureAdminColumns();
    res.json(await getProviderDocuments(req.params.providerId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/certifications/:certId/file', async (req, res) => {
  try {
    await ensureAdminColumns();
    const cert = await getCertificationFileRecord(req.params.certId);
    if (!cert || !cert.fileUrl) {
      return res.status(404).send('Certification file not found');
    }

    const fileUrl = cert.fileUrl.toString().trim();
    if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
      return res.redirect(fileUrl);
    }
    if (fileUrl.startsWith('/') || fileUrl.startsWith('uploads/')) {
      return res.redirect(fileUrl.startsWith('/') ? fileUrl : `/${fileUrl}`);
    }

    const parsed = parseDataUrl(fileUrl);
    if (!parsed) {
      return res.status(400).send('Unsupported certification file format');
    }
    const detected = sniffFileType(parsed.buffer, cert.mimeType || parsed.mimeType);
    if (!detected.valid) {
      return sendInvalidFileMessage(res);
    }
    const safeName = (
      cert.originalName ||
      cert.name ||
      'certification'
    ).toString().replace(/[^\w.\- ]+/g, '_');
    const filename = safeName.includes('.')
      ? safeName
      : `${safeName}.${detected.ext}`;
    res.setHeader('Content-Type', detected.mimeType);
    res.setHeader('Content-Length', parsed.buffer.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(parsed.buffer);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

router.put('/certifications/:certId/verify', async (req, res) => {
  try {
    await ensureAdminColumns();
    await db.execute(
      'UPDATE provider_certification SET isVerified = 1, verifiedAt = NOW() WHERE certId = ?',
      [req.params.certId],
    );
    res.json({ success: true, message: 'Certification verified' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/providers/:providerId/approval', async (req, res) => {
  const status = (req.body?.status || '').toString().toLowerCase().trim();
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved, rejected, or pending' });
  }

  try {
    await ensureAdminColumns();
    if (status === 'approved') {
      const certs = await getCertifications(req.params.providerId);
      const documents = await getProviderDocuments(req.params.providerId);
      const hasUnverified = certs.some((cert) => !cert.isVerified);
      const hasUploadedDocuments = documents.some(
        (doc) =>
          doc.medical_certificate ||
          doc.nursing_license ||
          doc.id_card ||
          doc.cv_file,
      );
      if ((certs.length === 0 && !hasUploadedDocuments) || hasUnverified) {
        return res.status(409).json({
          error:
            'Review provider documents and verify certifications before approving this account.',
        });
      }
    }

    await db.execute(
      'UPDATE careprovider SET approvalStatus = ? WHERE userId = ?',
      [status, req.params.providerId],
    );
    if (status === 'approved') {
      const [[rate]] = await db.query(
        `SELECT rateAcceptanceStatus
         FROM provider_rates
         WHERE BINARY providerId = BINARY ?
         ORDER BY id DESC
         LIMIT 1`,
        [req.params.providerId],
      );
      const active = (rate?.rateAcceptanceStatus || '').toLowerCase() === 'accepted';
      await db.execute('UPDATE user SET isActive = ? WHERE userId = ?', [
        active ? 1 : 0,
        req.params.providerId,
      ]);
      await db.execute(
        `UPDATE careprovider
         SET status = ?, is_rate_approved = ?
         WHERE userId = ?`,
        [active ? 'active' : 'inactive', active ? 1 : 0, req.params.providerId],
      );
    } else {
      await db.execute('UPDATE user SET isActive = 0 WHERE userId = ?', [
        req.params.providerId,
      ]);
      await db.execute(
        `UPDATE careprovider
         SET status = 'inactive', is_rate_approved = 0
         WHERE userId = ?`,
        [req.params.providerId],
      );
    }
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:userId/status', async (req, res) => {
  const isActive = Boolean(req.body?.isActive);
  try {
    await ensureAdminColumns();
    await db.execute('UPDATE user SET isActive = ? WHERE userId = ?', [
      isActive ? 1 : 0,
      req.params.userId,
    ]);
    res.json({ success: true, isActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:userId', async (req, res) => {
  const fullName = (req.body?.fullName || '').toString().trim();
  const phone = (req.body?.phone || '').toString().trim();
  const specialization = (req.body?.specialization || '').toString().trim();
  const serviceType = (req.body?.serviceType || '').toString().trim();
  const addressText = (req.body?.addressText || '').toString().trim();

  if (!fullName || !phone) {
    return res.status(400).json({ error: 'fullName and phone are required' });
  }

  const conn = await db.getConnection();
  try {
    await ensureAdminColumns();
    await conn.beginTransaction();
    await conn.execute('UPDATE user SET fullName = ?, phone = ? WHERE userId = ?', [
      fullName,
      phone,
      req.params.userId,
    ]);
    await conn.execute(
      `UPDATE careprovider
       SET specialization = COALESCE(NULLIF(?, ''), specialization),
           serviceType = COALESCE(NULLIF(?, ''), serviceType)
       WHERE userId = ?`,
      [specialization, serviceType, req.params.userId],
    );
    await conn.execute(
      `UPDATE patient
       SET addressText = COALESCE(NULLIF(?, ''), addressText)
       WHERE userId = ?`,
      [addressText, req.params.userId],
    );
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
