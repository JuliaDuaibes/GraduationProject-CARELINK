const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { insertNotification } = require('../notifications');
const medicalRecordService = require('../services/medicalRecordService');
const { recordPaymentSplit } = require('../services/bookingPaymentService');

const router = express.Router();

const columnCache = new Map();
const DEFAULT_VISIT_PAYMENT_AMOUNT = 25;

async function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (columnCache.has(key)) return columnCache.get(key);
  try {
    const [rows] = await db.query(`SHOW COLUMNS FROM ${tableName} LIKE ?`, [
      columnName,
    ]);
    const exists = rows.length > 0;
    columnCache.set(key, exists);
    return exists;
  } catch (_) {
    columnCache.set(key, false);
    return false;
  }
}

async function hasTable(tableName) {
  const key = `table.${tableName}`;
  if (columnCache.has(key)) return columnCache.get(key);
  try {
    const [rows] = await db.query(`SHOW TABLES LIKE ?`, [tableName]);
    const exists = rows.length > 0;
    columnCache.set(key, exists);
    return exists;
  } catch (_) {
    columnCache.set(key, false);
    return false;
  }
}

async function ensureAuxTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS nurse_appsettings (
      userId VARCHAR(64) PRIMARY KEY,
      settingsJson TEXT NOT NULL,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_payment_method (
      methodId VARCHAR(64) PRIMARY KEY,
      providerUserId VARCHAR(64) NOT NULL,
      type VARCHAR(64) NOT NULL,
      details TEXT,
      isDefault TINYINT(1) NOT NULL DEFAULT 0,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_provider_payment_method (providerUserId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_certification (
      certId VARCHAR(64) PRIMARY KEY,
      providerUserId VARCHAR(64) NOT NULL,
      name VARCHAR(512) NOT NULL,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_provider_cert (providerUserId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
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
  const documentColumns = [
    ['medical_certificate', 'LONGTEXT NULL'],
    ['nursing_license', 'LONGTEXT NULL'],
    ['id_card', 'LONGTEXT NULL'],
    ['cv_file', 'LONGTEXT NULL'],
    ['workplace_history', 'TEXT NULL'],
    ['createdAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['updatedAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ];
  for (const [column, definition] of documentColumns) {
    if (await hasColumn('provider_documents', column)) continue;
    try {
      await db.query(`ALTER TABLE provider_documents ADD COLUMN ${column} ${definition}`);
      columnCache.set(`provider_documents.${column}`, true);
    } catch (_) {}
  }
  for (const column of ['medical_certificate', 'nursing_license', 'id_card', 'cv_file']) {
    try {
      await db.query(`ALTER TABLE provider_documents MODIFY COLUMN ${column} LONGTEXT NULL`);
      columnCache.set(`provider_documents.${column}`, true);
    } catch (_) {}
  }
}

async function ensureNurseEditableProfileColumns() {
  const additions = [
    ['years_experience', 'INT NULL'],
    ['biography', 'TEXT NULL'],
    ['service_areas', 'TEXT NULL'],
  ];

  for (const [column, definition] of additions) {
    if (await hasColumn('careprovider', column)) continue;
    try {
      await db.query(`ALTER TABLE careprovider ADD COLUMN ${column} ${definition}`);
      columnCache.set(`careprovider.${column}`, true);
    } catch (_) {}
  }
  if (!(await hasColumn('user', 'profileImageUrl'))) {
    try {
      await db.query(`ALTER TABLE user ADD COLUMN profileImageUrl LONGTEXT NULL`);
      columnCache.set('user.profileImageUrl', true);
    } catch (_) {}
  } else {
    try {
      await db.query(`ALTER TABLE user MODIFY COLUMN profileImageUrl LONGTEXT NULL`);
    } catch (_) {}
  }
}

async function ensureAvailabilitySlotTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS availabilityslot (
      slot_id VARCHAR(64) PRIMARY KEY,
      providerUserId VARCHAR(64) NOT NULL,
      day VARCHAR(32) NOT NULL,
      startTime TIME NOT NULL,
      endTime TIME NOT NULL,
      KEY idx_availability_provider (providerUserId),
      KEY idx_availability_lookup (providerUserId, day, startTime)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const additions = [
    ['providerUserId', 'VARCHAR(64) NOT NULL DEFAULT ""'],
    ['day', 'VARCHAR(32) NOT NULL DEFAULT ""'],
    ['date', 'DATE NULL'],
    ['startTime', 'TIME NULL'],
    ['endTime', 'TIME NULL'],
  ];

  for (const [column, type] of additions) {
    if (!(await hasColumn('availabilityslot', column))) {
      await db.query(`ALTER TABLE availabilityslot ADD COLUMN ${column} ${type}`);
      columnCache.set(`availabilityslot.${column}`, true);
    }
  }
}

async function ensureCareProviderForAvailability(conn, providerId, hasSlots) {
  const available = hasSlots ? 1 : 0;
  const sets = ['isAvailable = ?'];
  const values = [available];

  if (await hasColumn('careprovider', 'serviceType')) {
    sets.push("serviceType = COALESCE(NULLIF(serviceType, ''), ?)");
    values.push('Home visit');
  }
  if (await hasColumn('careprovider', 'specialization')) {
    sets.push("specialization = COALESCE(NULLIF(specialization, ''), ?)");
    values.push('Home Nursing');
  }

  values.push(providerId);
  const [updated] = await conn.execute(
    `UPDATE careprovider SET ${sets.join(', ')} WHERE userId = ?`,
    values,
  );
  if (updated.affectedRows > 0) return;

  const columns = ['userId', 'specialization', 'overallRating', 'isAvailable'];
  const insertValues = [providerId, 'Home Nursing', 0, available];

  if (await hasColumn('careprovider', 'serviceType')) {
    columns.push('serviceType');
    insertValues.push('Home visit');
  }
  if (await hasColumn('careprovider', 'approvalStatus')) {
    columns.push('approvalStatus');
    insertValues.push('approved');
  }

  const placeholders = columns.map(() => '?').join(', ');
  await conn.execute(
    `INSERT INTO careprovider (${columns.join(', ')}) VALUES (${placeholders})`,
    insertValues,
  );
}

async function ensureServiceVisitWorkflowColumns() {
  const additions = [
    ['actualStartedAt', 'DATETIME NULL'],
    ['actualEndedAt', 'DATETIME NULL'],
    ['actualDurationMinutes', 'INT NOT NULL DEFAULT 0'],
    ['nursingActivities', 'TEXT NULL'],
  ];
  for (const [column, type] of additions) {
    if (!(await hasColumn('servicerequest', column))) {
      await db.query(`ALTER TABLE servicerequest ADD COLUMN ${column} ${type}`);
      columnCache.set(`servicerequest.${column}`, true);
    }
  }
}

const DEFAULT_SETTINGS = {
  newRequestsNotifications: true,
  scheduleReminders: true,
  paymentNotifications: true,
  messageNotifications: true,
  emergencyAlerts: true,
  profileVisible: true,
  showPhoneNumber: false,
  showEmail: false,
  darkMode: false,
  language: 'English',
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  if (
    ![lat1, lon1, lat2, lon2].every(
      (v) => typeof v === 'number' && Number.isFinite(v),
    )
  ) {
    return null;
  }
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function assertNurseUser(userId, res) {
  const [rows] = await db.query(
    `SELECT role FROM user WHERE userId = ? LIMIT 1`,
    [userId],
  );
  if (!rows.length) {
    res.status(404).json({ error: 'User not found' });
    return false;
  }
  if ((rows[0].role || '').toLowerCase() !== 'nurse') {
    res.status(403).json({ error: 'Nurse access only' });
    return false;
  }
  return true;
}

/** --- Settings --- */
router.get('/settings/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    await ensureAuxTables();
    const [rows] = await db.query(
      `SELECT settingsJson FROM nurse_appsettings WHERE userId = ?`,
      [userId],
    );
    if (!rows.length) {
      return res.json(DEFAULT_SETTINGS);
    }
    try {
      const parsed = JSON.parse(rows[0].settingsJson || '{}');
      return res.json({ ...DEFAULT_SETTINGS, ...parsed });
    } catch (_) {
      return res.json(DEFAULT_SETTINGS);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings/:userId', async (req, res) => {
  const { userId } = req.params;
  const body = { ...DEFAULT_SETTINGS, ...(req.body || {}) };
  try {
    await ensureAuxTables();
    const json = JSON.stringify(body);
    await db.execute(
      `INSERT INTO nurse_appsettings (userId, settingsJson)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE settingsJson = VALUES(settingsJson)`,
      [userId, json],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** --- Dashboard --- */
router.get('/dashboard/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    if (!(await assertNurseUser(userId, res))) return;

    const [[pending]] = await db.query(
      `SELECT COUNT(*) AS c FROM servicerequest
       WHERE providerUserId = ? AND status IN ('pending', 'pending_provider_approval')`,
      [userId],
    );
    const [[today]] = await db.query(
      `SELECT COUNT(*) AS c FROM servicerequest
       WHERE providerUserId = ?
         AND status IN ('confirmed','accepted','in_progress','waiting_report')
         AND DATE(scheduledAt) = CURDATE()`,
      [userId],
    );
    const [[waitingReports]] = await db.query(
      `SELECT COUNT(*) AS c FROM servicerequest
       WHERE providerUserId = ? AND status = 'waiting_report'`,
      [userId],
    );
    const [[done]] = await db.query(
      `SELECT COUNT(*) AS c FROM servicerequest
       WHERE providerUserId = ? AND status = 'completed'`,
      [userId],
    );

    let weeklyEarnings = 0;
    try {
      await syncProviderPayments(userId);
      const queryParts = [];
      const params = [];
      if (await hasTable('payment')) {
        queryParts.push(
          `SELECT ${await providerShareSqlExpr()} AS amount, paymentStatus AS status, createdAt
           FROM payment
           WHERE providerUserId = ?`
        );
        params.push(userId);
      }
      if (await hasTable('payments')) {
        queryParts.push(
          `SELECT amount, status AS status, created_at AS createdAt
           FROM payments
           WHERE provider_id = ?`
        );
        params.push(userId);
      }
      if (queryParts.length) {
        const [[pay]] = await db.query(
          `SELECT COALESCE(SUM(amount), 0) AS s FROM (
             ${queryParts.join(' UNION ALL ')}
           ) AS allp
           WHERE status IN ('paid', 'pending', 'unpaid')
             AND YEARWEEK(createdAt, 1) = YEARWEEK(CURDATE(), 1)`,
          params,
        );
        weeklyEarnings = Number(pay?.s || 0);
      }
    } catch (_) {}

    res.json({
      pendingRequests: Number(pending?.c || 0),
      todaysVisits: Number(today?.c || 0),
      waitingReports: Number(waitingReports?.c || 0),
      completedVisits: Number(done?.c || 0),
      weeklyEarnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** --- Service requests (list + status) --- */
async function listRequestsForProvider(providerUserId, statusQ) {
  await ensureServiceVisitWorkflowColumns();
  const hasVisitAddress = await hasColumn('servicerequest', 'visitAddress');
  const hasVisitLatitude = await hasColumn('servicerequest', 'visitLatitude');
  const hasVisitLongitude = await hasColumn('servicerequest', 'visitLongitude');
  const hasCreatedAt = await hasColumn('servicerequest', 'createdAt');
  const hasReasonForVisit = await hasColumn('servicerequest', 'reasonForVisit');
  const hasLocationNote = await hasColumn('servicerequest', 'locationNote');
  const hasPatientLat = await hasColumn('patient', 'gpsLat');
  const hasPatientLng = await hasColumn('patient', 'gpsLng');
  const hasPatientAddress = await hasColumn('patient', 'addressText');
  const hasMedicalDob = await hasColumn('medicalrecord', 'dateOfBirth');
  const hasPaymentTable = await hasTable('payment');
  const hasAdminReviewStatus = await hasColumn('servicerequest', 'adminReviewStatus');
  const hasAdminReviewDecision = await hasColumn('servicerequest', 'adminReviewDecision');
  const createdExpr = hasCreatedAt ? 'sr.createdAt' : 'sr.scheduledAt';
  const visitAddressSel = hasVisitAddress ? 'sr.visitAddress' : "'' AS visitAddress";
  const visitLatSel = hasVisitLatitude ? 'sr.visitLatitude' : 'NULL AS visitLatitude';
  const visitLngSel = hasVisitLongitude ? 'sr.visitLongitude' : 'NULL AS visitLongitude';
  const reasonSel = hasReasonForVisit ? 'sr.reasonForVisit' : "'' AS reasonForVisit";
  const locationNoteSel = hasLocationNote ? 'sr.locationNote' : "'' AS locationNote";
  const patientLatSel = hasPatientLat ? 'pat.gpsLat' : 'NULL AS gpsLat';
  const patientLngSel = hasPatientLng ? 'pat.gpsLng' : 'NULL AS gpsLng';
  const patientAddressSel = hasPatientAddress ? 'pat.addressText' : "'' AS patientAddress";
  const dobSel = hasMedicalDob ? 'mr.dateOfBirth' : 'NULL AS dateOfBirth';
  const priceSel = hasPaymentTable ? 'p.amount' : 'NULL AS amount';
  const adminReviewStatusSel = hasAdminReviewStatus
    ? 'sr.adminReviewStatus'
    : "NULL AS adminReviewStatus";
  const adminReviewDecisionSel = hasAdminReviewDecision
    ? 'sr.adminReviewDecision'
    : "NULL AS adminReviewDecision";

  const params = [providerUserId];
  let statusClause = '';
  if (statusQ && statusQ.length) {
    statusClause = ' AND LOWER(sr.status) = ?';
    params.push(statusQ.toLowerCase());
  }

  const [rows] = await db.query(
    `SELECT
        sr.requestId AS requestId,
        sr.patientUserId AS patientUserId,
        sr.providerUserId AS providerUserId,
        sr.serviceType,
        sr.status,
        sr.notes,
        ${reasonSel},
        ${locationNoteSel},
        sr.location,
        sr.scheduledAt,
        sr.confirmedAt,
        sr.completedAt,
        sr.actualStartedAt,
        sr.actualEndedAt,
        sr.actualDurationMinutes,
        sr.nursingActivities,
        ${visitAddressSel},
        ${visitLatSel},
        ${visitLngSel},
        ${createdExpr} AS createdAt,
        pu.fullName AS patientName,
        pu.phone AS patientPhone,
        ${patientLatSel},
        ${patientLngSel},
        ${patientAddressSel},
        ${dobSel},
        ${priceSel},
        ${adminReviewStatusSel},
        ${adminReviewDecisionSel}
     FROM servicerequest sr
     LEFT JOIN user pu ON BINARY sr.patientUserId = BINARY pu.userId
     LEFT JOIN patient pat ON BINARY pat.userId = BINARY sr.patientUserId
     LEFT JOIN medicalrecord mr ON BINARY mr.patientUserId = BINARY sr.patientUserId
     ${hasPaymentTable ? 'LEFT JOIN payment p ON BINARY p.requestId = BINARY sr.requestId' : ''}
     WHERE BINARY sr.providerUserId = BINARY ?
       AND LOWER(TRIM(CAST(sr.status AS CHAR(64)))) <> 'draft'${statusClause}
     ORDER BY sr.scheduledAt DESC
     LIMIT 500`,
    params,
  );

  return rows.map((r) => {
    const noteText = (r.notes || '').toString();
    const addressMatch = /Address:\s*([^|]+)/i.exec(noteText);
    const gpsMatch = /VisitGPS:\s*([-.\d]+)\s*,\s*([-.\d]+)/i.exec(noteText);
    const parsedAddress = addressMatch ? addressMatch[1].trim() : '';
    const parsedLat = gpsMatch ? Number(gpsMatch[1]) : null;
    const parsedLng = gpsMatch ? Number(gpsMatch[2]) : null;
    const adminReviewStatus = (r.adminReviewStatus || '').toString().trim().toLowerCase();
    const adminReviewDecision = (r.adminReviewDecision || '').toString().trim().toLowerCase();
    const effectiveStatus =
      adminReviewStatus === 'dispute' || adminReviewDecision === 'mark_dispute'
        ? 'dispute'
        : r.status;
    return {
      requestId: r.requestId,
      patientUserId: r.patientUserId,
      providerUserId: r.providerUserId,
      patientId: r.patientUserId,
      providerId: r.providerUserId,
      patientName: r.patientName || '',
      patientPhone: r.patientPhone || '',
      patientAge: r.dateOfBirth ? Math.max(0, new Date().getFullYear() - new Date(r.dateOfBirth).getFullYear()) : 0,
      serviceType: r.serviceType || '',
      location: (r.visitAddress && String(r.visitAddress).trim()) || r.location || parsedAddress || r.patientAddress || '',
      patientAddress: r.patientAddress || '',
      gpsLat: r.visitLatitude ?? r.gpsLat ?? parsedLat,
      gpsLng: r.visitLongitude ?? r.gpsLng ?? parsedLng,
      status: effectiveStatus,
      notes: r.notes,
      adminReviewStatus,
      adminReviewDecision,
      reasonForVisit: r.reasonForVisit || '',
      locationNote: r.locationNote || '',
      medicalCondition: r.reasonForVisit || r.notes || '',
      scheduledAt: r.scheduledAt,
      scheduledDate: r.scheduledAt,
      expectedDurationHours: 2,
      price: r.amount == null ? 0 : Number(r.amount || 0),
      actualStartedAt: r.actualStartedAt,
      actualEndedAt: r.actualEndedAt,
      actualDurationMinutes: Number(r.actualDurationMinutes || 0),
      nursingActivities: (() => {
        try {
          return r.nursingActivities ? JSON.parse(r.nursingActivities) : [];
        } catch (_) {
          return [];
        }
      })(),
      createdAt: r.createdAt,
    };
  });
}

router.get('/requests/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const statusQ = req.query.status ? req.query.status.toString().trim() : '';
  try {
    const [userRows] = await db.query(
      `SELECT role FROM user WHERE userId = ?`,
      [providerId],
    );
    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    if ((userRows[0].role || '').toLowerCase() !== 'nurse') {
      return res.status(403).json({ error: 'Nurse requests only' });
    }

    let normalizedStatus = statusQ.toLowerCase();
    if (normalizedStatus === 'scheduled' || normalizedStatus === 'assigned') {
      normalizedStatus = 'confirmed';
    }

    const rows = await listRequestsForProvider(
      providerId,
      normalizedStatus && normalizedStatus !== 'all' ? normalizedStatus : '',
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/patients/:patientId/medical-records', async (req, res) => {
  const patientId = (req.params.patientId || '').toString().trim();
  const providerId = (req.query.providerId || req.headers['x-provider-id'] || '')
    .toString()
    .trim();

  if (!patientId || !providerId) {
    return res.status(400).json({ error: 'patientId and providerId are required' });
  }

  try {
    const [nurseRows] = await db.query(
      `SELECT role FROM user WHERE BINARY userId = BINARY ? LIMIT 1`,
      [providerId],
    );
    if (!nurseRows.length || (nurseRows[0].role || '').toLowerCase() !== 'nurse') {
      return res.status(403).json({ error: 'Nurse medical records only' });
    }

    const [linkRows] = await db.query(
      `SELECT requestId
       FROM servicerequest
       WHERE BINARY patientUserId = BINARY ?
         AND BINARY providerUserId = BINARY ?
       LIMIT 1`,
      [patientId, providerId],
    );
    if (!linkRows.length) {
      return res.status(403).json({ error: 'No care relationship with this patient' });
    }

    const hasDob = await hasColumn('medicalrecord', 'dateOfBirth');
    const hasBloodType = await hasColumn('medicalrecord', 'bloodType');
    const hasPastSurgeries = await hasColumn('medicalrecord', 'pastSurgeries');
    const hasPreviousDiagnoses = await hasColumn('medicalrecord', 'previousDiagnoses');
    const hasDoctorNotes = await hasColumn('medicalrecord', 'doctorNotes');
    const hasNurseNotes = await hasColumn('medicalrecord', 'nurseNotes');
    const [summaryRows] = await db.query(
      `SELECT
         mr.recordId,
         ${hasDob ? 'mr.dateOfBirth' : 'NULL AS dateOfBirth'},
         ${hasBloodType ? 'mr.bloodType' : "'' AS bloodType"},
         ${hasPastSurgeries ? 'mr.pastSurgeries' : "'' AS pastSurgeries"},
         ${hasPreviousDiagnoses ? 'mr.previousDiagnoses' : "'' AS previousDiagnoses"},
         ${hasDoctorNotes ? 'mr.doctorNotes' : "'' AS doctorNotes"},
         ${hasNurseNotes ? 'mr.nurseNotes' : "'' AS nurseNotes"},
         u.fullName AS patientName,
         u.phone AS patientPhone
       FROM medicalrecord mr
       LEFT JOIN user u ON BINARY u.userId = BINARY mr.patientUserId
       WHERE BINARY mr.patientUserId = BINARY ?
       LIMIT 1`,
      [patientId],
    );

    const [diseases] = await db.query(
      `SELECT d.diseaseName
       FROM medicalrecorddisease mrd
       JOIN disease d ON d.diseaseId = mrd.diseaseId
       WHERE BINARY mrd.recordId = BINARY ?`,
      [summaryRows[0]?.recordId || ''],
    ).catch(() => [[]]);

    const [allergies] = await db.query(
      `SELECT a.allergyName
       FROM medicalrecordallergy mra
       JOIN allergy a ON a.allergyId = mra.allergyId
       WHERE BINARY mra.recordId = BINARY ?`,
      [summaryRows[0]?.recordId || ''],
    ).catch(() => [[]]);

    const records = await medicalRecordService.listPatientVisibleRecords(patientId);
    res.json({
      patientId,
      summary: {
        ...(summaryRows[0] || {}),
        diseases: diseases.map((d) => d.diseaseName).filter(Boolean),
        allergies: allergies.map((a) => a.allergyName).filter(Boolean),
      },
      records,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/requests/:requestId/status', async (req, res) => {
  const { requestId } = req.params;
  let { providerUserId, status, scheduledAt } = req.body || {};
  providerUserId = providerUserId ? providerUserId.toString().trim() : '';
  let next = status ? status.toString().trim().toLowerCase() : '';
  if (next === 'scheduled' || next === 'assigned') {
    next = 'confirmed';
  }
  scheduledAt = scheduledAt ? scheduledAt.toString().trim() : '';

  if (!providerUserId || !next) {
    return res
      .status(400)
      .json({ error: 'providerUserId and status are required' });
  }

  const allowed = new Set([
    'confirmed',
    'accepted',
    'cancelled',
    'in_progress',
    'waiting_report',
    'completed',
  ]);
  if (!allowed.has(next)) {
    return res.status(400).json({
      error:
        'status must be one of: accepted, confirmed, cancelled, in_progress, waiting_report, completed',
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT requestId, patientUserId, providerUserId, status,
              paymentStatus, paymentMethod
       FROM servicerequest
       WHERE requestId = ?`,
      [requestId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const row = rows[0];
    if (row.providerUserId !== providerUserId) {
      return res.status(403).json({ error: 'Not allowed for this provider' });
    }

    const current = (row.status || '').toString().toLowerCase();

    if (['completed', 'cancelled'].includes(current)) {
      return res.status(409).json({ error: 'This request is already closed' });
    }

    if (next === 'confirmed' || next === 'accepted' || next === 'in_progress') {
      try {
        await assertProviderCanWork(providerUserId);
      } catch (e) {
        return res.status(e.status || 403).json({
          error: e.message,
          eligibility: e.eligibility || null,
        });
      }
    }

    if (current === 'pending' || current === 'pending_provider_approval') {
      if (next !== 'confirmed' && next !== 'accepted' && next !== 'cancelled') {
        return res
          .status(400)
          .json({ error: 'From pending, only accepted, confirmed or cancelled' });
      }
    } else if (current === 'pending_payment' || current === 'payment_pending') {
      if (next !== 'confirmed' && next !== 'accepted' && next !== 'cancelled') {
        return res
          .status(400)
          .json({ error: 'From pending payment, only accepted, confirmed or cancelled' });
      }
    } else if (current === 'confirmed' || current === 'accepted') {
      if (
        next !== 'confirmed' &&
        next !== 'accepted' &&
        next !== 'in_progress' &&
        next !== 'cancelled' &&
        next !== 'completed'
      ) {
        return res
          .status(400)
          .json({ error: 'From accepted, only in_progress, completed or cancelled' });
      }
    } else if (current === 'in_progress') {
      if (next !== 'waiting_report' && next !== 'completed') {
        return res
          .status(400)
          .json({ error: 'From in_progress, only waiting_report or completed' });
      }
    } else if (current === 'waiting_report') {
      if (next !== 'completed') {
        return res
          .status(400)
          .json({ error: 'From waiting_report, only completed' });
      }
    } else {
      return res.status(400).json({ error: 'Unexpected current status' });
    }

    const effectiveNext = next;

    if (next === 'confirmed' || next === 'accepted') {
      const sets = ['status = ?', 'confirmedAt = COALESCE(confirmedAt, NOW())'];
      const vals = [effectiveNext];
      if (scheduledAt) {
        sets.push('scheduledAt = ?');
        vals.push(scheduledAt.replace('T', ' ').replace('Z', '').slice(0, 19));
      }
      vals.push(requestId, providerUserId);
      await db.execute(
        `UPDATE servicerequest
         SET ${sets.join(', ')}
         WHERE requestId = ? AND providerUserId = ?`,
        vals,
      );
    } else {
      await db.execute(
        `UPDATE servicerequest SET status = ? WHERE requestId = ? AND providerUserId = ?`,
        [effectiveNext, requestId, providerUserId],
      );
    }
    if (next === 'confirmed' || next === 'accepted') {
      try {
        await ensurePaymentForRequest(requestId);
      } catch (_) {}
    }

    const titles = {
      accepted: { title: 'تم قبول الموعد', en: 'Appointment accepted' },
      confirmed: { title: 'تم قبول الموعد', en: 'Appointment accepted' },
      cancelled: { title: 'تم رفض أو إلغاء الموعد', en: 'Visit cancelled' },
      completed: { title: 'تم إكمال الخدمة', en: 'Visit completed' },
    };
    const t = titles[next] || { title: 'تحديث الطلب', en: 'Booking update' };

    try {
      await insertNotification({
        userId: row.patientUserId,
        type: 'appointment',
        title: effectiveNext === 'pending_payment' ? 'الدفع مطلوب' : t.title,
        body:
          effectiveNext === 'pending_payment'
            ? 'يرجى إكمال الدفع قبل تأكيد الموعد.'
            : next === 'confirmed' || next === 'accepted'
            ? 'مقدّم الرعاية قبل الطلب. ستصلك إشعارات متابعة على CareLink.'
            : next === 'cancelled'
              ? 'تم إلغاء هذا الطلب. يمكنك اختيار مقدّم خدمة آخر.'
              : 'سجّلنا إكمال زيارة الخدمة. شكراً لاستخدامك CareLink.',
        relatedRequestId: requestId,
      });
    } catch (_) {}

    res.json({
      success: true,
      requestId,
      status: effectiveNext,
      paymentRequired: effectiveNext === 'pending_payment',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/requests/:requestId/start', async (req, res) => {
  const { requestId } = req.params;
  const providerUserId = (req.body?.providerUserId || '').toString().trim();
  if (!providerUserId) {
    return res.status(400).json({ error: 'providerUserId is required' });
  }
  try {
    await ensureServiceVisitWorkflowColumns();
    const [rows] = await db.query(
      `SELECT requestId, patientUserId, providerUserId, status, actualStartedAt
       FROM servicerequest
       WHERE BINARY requestId = BINARY ?`,
      [requestId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    const row = rows[0];
    if (row.providerUserId !== providerUserId) {
      return res.status(403).json({ error: 'Not allowed for this provider' });
    }
    const current = (row.status || '').toString().toLowerCase();
    if (!['accepted', 'confirmed', 'in_progress'].includes(current)) {
      return res.status(400).json({ error: 'Only assigned visits can be started' });
    }
    try {
      await assertProviderCanWork(providerUserId);
    } catch (e) {
      return res.status(e.status || 403).json({
        error: e.message,
        eligibility: e.eligibility || null,
      });
    }
    await db.execute(
      `UPDATE servicerequest
       SET status = 'in_progress',
           actualStartedAt = COALESCE(actualStartedAt, NOW())
       WHERE BINARY requestId = BINARY ? AND BINARY providerUserId = BINARY ?`,
      [requestId, providerUserId],
    );
    try {
      await insertNotification({
        userId: row.patientUserId,
        type: 'appointment',
        title: 'بدأت الزيارة',
        body: 'الممرض بدأ زيارة الخدمة الآن.',
        relatedRequestId: requestId,
      });
    } catch (_) {}
    res.json({ success: true, requestId, status: 'in_progress' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/requests/:requestId/end', async (req, res) => {
  const { requestId } = req.params;
  const providerUserId = (req.body?.providerUserId || '').toString().trim();
  const nursingActivities = Array.isArray(req.body?.nursingActivities)
    ? req.body.nursingActivities
    : [];
  if (!providerUserId) {
    return res.status(400).json({ error: 'providerUserId is required' });
  }
  try {
    await ensureServiceVisitWorkflowColumns();
    const [rows] = await db.query(
      `SELECT requestId, providerUserId, status, actualStartedAt
       FROM servicerequest
       WHERE BINARY requestId = BINARY ?`,
      [requestId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    const row = rows[0];
    if (row.providerUserId !== providerUserId) {
      return res.status(403).json({ error: 'Not allowed for this provider' });
    }
    const current = (row.status || '').toString().toLowerCase();
    if (current !== 'in_progress') {
      return res.status(400).json({ error: 'Only in-progress visits can be ended' });
    }
    await db.execute(
      `UPDATE servicerequest
       SET status = 'waiting_report',
           actualEndedAt = NOW(),
           actualDurationMinutes = GREATEST(
             0,
             TIMESTAMPDIFF(MINUTE, COALESCE(actualStartedAt, NOW()), NOW())
           ),
           nursingActivities = ?
       WHERE BINARY requestId = BINARY ? AND BINARY providerUserId = BINARY ?`,
      [JSON.stringify(nursingActivities), requestId, providerUserId],
    );
    res.json({ success: true, requestId, status: 'waiting_report' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** AI-style recommendations: pending visits for this nurse + distance hint */
router.get('/recommendations/:nurseUserId', async (req, res) => {
  const { nurseUserId } = req.params;
  try {
    if (!(await assertNurseUser(nurseUserId, res))) return;

    const hasNurseLat = await hasColumn('careprovider', 'gpsLat');
    const hasNurseLng = await hasColumn('careprovider', 'gpsLng');
    const hasPatientLat = await hasColumn('patient', 'gpsLat');
    const hasPatientLng = await hasColumn('patient', 'gpsLng');

    let nurseLat = null;
    let nurseLng = null;
    if (hasNurseLat && hasNurseLng) {
      const [[np]] = await db.query(
        `SELECT gpsLat, gpsLng FROM careprovider WHERE userId = ?`,
        [nurseUserId],
      );
      if (np) {
        nurseLat = np.gpsLat != null ? Number(np.gpsLat) : null;
        nurseLng = np.gpsLng != null ? Number(np.gpsLng) : null;
      }
    }

    const [rows] = await db.query(
      `SELECT sr.requestId, sr.serviceType, sr.location, sr.notes, sr.scheduledAt,
              pu.fullName AS patientName,
              pat.addressText,
              ${hasPatientLat ? 'pat.gpsLat' : 'NULL AS gpsLat'},
              ${hasPatientLng ? 'pat.gpsLng' : 'NULL AS gpsLng'}
       FROM servicerequest sr
       JOIN user pu ON pu.userId = sr.patientUserId
       LEFT JOIN patient pat ON pat.userId = sr.patientUserId
       WHERE sr.providerUserId = ?
         AND sr.status = 'pending'
       ORDER BY sr.scheduledAt ASC
       LIMIT 50`,
      [nurseUserId],
    );

    const out = rows.map((r) => {
      const plat = r.gpsLat != null ? Number(r.gpsLat) : null;
      const plng = r.gpsLng != null ? Number(r.gpsLng) : null;
      const km = haversineKm(nurseLat, nurseLng, plat, plng);
      let recommendationReason = 'Pending visit matched to your profile.';
      if (km != null) {
        recommendationReason = `About ${km.toFixed(1)} km from your base · ${r.serviceType || 'care visit'}`;
      } else if ((r.addressText || '').trim()) {
        recommendationReason = `${r.addressText.trim()} · ${r.serviceType || ''}`.trim();
      }
      return {
        recommendationId: r.requestId,
        requestId: r.requestId,
        patientName: r.patientName || 'Patient',
        recommendationReason,
        addressText: r.addressText || '',
        serviceType: r.serviceType || '',
      };
    });

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recommendations/:nurseUserId/:recommendationId/accept', async (req, res) => {
  const { nurseUserId, recommendationId } = req.params;
  try {
    try {
      await assertProviderCanWork(nurseUserId);
    } catch (err) {
      return res.status(err.status || 403).json({
        error: err.message,
        eligibility: err.eligibility || null,
      });
    }
    const [rows] = await db.query(
      `SELECT requestId, patientUserId, providerUserId, status
       FROM servicerequest WHERE requestId = ?`,
      [recommendationId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const row = rows[0];
    if (row.providerUserId !== nurseUserId) {
      return res.status(403).json({ error: 'Not your recommendation' });
    }
    const current = (row.status || '').toString().toLowerCase();
    if (current !== 'pending') {
      return res.status(409).json({ error: 'Request is not pending' });
    }
    await db.execute(
      `UPDATE servicerequest
       SET status = 'pending_payment',
           paymentMethod = 'mock_card',
           paymentStatus = 'pending'
       WHERE requestId = ? AND providerUserId = ?`,
      [recommendationId, nurseUserId],
    );
    try {
      await ensurePaymentForRequest(recommendationId);
    } catch (_) {}
    try {
      await insertNotification({
        userId: row.patientUserId,
        type: 'appointment',
        title: 'تم قبول الموعد',
        body: 'الممرض/ة قبل طلب الزيارة.',
        relatedRequestId: recommendationId,
      });
    } catch (_) {}
    res.json({
      success: true,
      requestId: recommendationId,
      status: 'pending_payment',
      paymentRequired: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** --- Visit reports (nurse UI shape ↔ visit_reports table) --- */
async function ensureVisitReportUiColumns() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS visit_reports (
      id CHAR(36) NOT NULL PRIMARY KEY,
      patient_id CHAR(36) NOT NULL,
      provider_id CHAR(36) NOT NULL,
      appointment_id CHAR(36) NULL,
      vital_signs TEXT NULL,
      diagnosis TEXT NULL,
      treatment_plan TEXT NULL,
      recommendations TEXT NULL,
      follow_up_required TINYINT(1) NOT NULL DEFAULT 0,
      follow_up_date DATE NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_vr_patient (patient_id),
      KEY idx_vr_provider (provider_id),
      KEY idx_vr_appt (appointment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  if (!(await hasColumn('visit_reports', 'visit_date'))) {
    try {
      await db.execute(`ALTER TABLE visit_reports ADD COLUMN visit_date DATE NULL`);
      columnCache.set('visit_reports.visit_date', true);
    } catch (_) {}
  }
  if (!(await hasColumn('visit_reports', 'medications_prescribed'))) {
    try {
      await db.execute(
        `ALTER TABLE visit_reports ADD COLUMN medications_prescribed TEXT NULL`
      );
      columnCache.set('visit_reports.medications_prescribed', true);
    } catch (_) {}
  }
  if (!(await hasColumn('visit_reports', 'duration_hours'))) {
    try {
      await db.execute(
        `ALTER TABLE visit_reports ADD COLUMN duration_hours INT NOT NULL DEFAULT 0`
      );
      columnCache.set('visit_reports.duration_hours', true);
    } catch (_) {}
  }
  if (!(await hasColumn('visit_reports', 'manual_patient_name'))) {
    try {
      await db.execute(
        `ALTER TABLE visit_reports ADD COLUMN manual_patient_name VARCHAR(255) NULL`
      );
      columnCache.set('visit_reports.manual_patient_name', true);
    } catch (_) {}
  }
  if (!(await hasColumn('visit_reports', 'attachment_urls'))) {
    try {
      await db.execute(
        `ALTER TABLE visit_reports ADD COLUMN attachment_urls TEXT NULL`
      );
      columnCache.set('visit_reports.attachment_urls', true);
    } catch (_) {}
  }
}

async function ensureProviderRateAcceptanceColumns() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_rates (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      providerId CHAR(36) NOT NULL,
      specialization VARCHAR(100) NOT NULL,
      provider_hour_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      rateAcceptanceStatus ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
      rateSetAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      rateAcceptedAt DATETIME NULL,
      rateRejectedAt DATETIME NULL,
      UNIQUE KEY uq_provider_rate (providerId, specialization)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const additions = [
    [
      'rateAcceptanceStatus',
      "ALTER TABLE provider_rates ADD COLUMN rateAcceptanceStatus ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending'",
    ],
    ['rateSetAt', 'ALTER TABLE provider_rates ADD COLUMN rateSetAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['rateAcceptedAt', 'ALTER TABLE provider_rates ADD COLUMN rateAcceptedAt DATETIME NULL'],
    ['rateRejectedAt', 'ALTER TABLE provider_rates ADD COLUMN rateRejectedAt DATETIME NULL'],
  ];
  for (const [column, sql] of additions) {
    if (await hasColumn('provider_rates', column)) continue;
    try {
      await db.query(sql);
      columnCache.set(`provider_rates.${column}`, true);
    } catch (_) {}
  }
}

async function ensureProviderWorkColumns() {
  if (!(await hasColumn('user', 'isActive'))) {
    await db.query('ALTER TABLE user ADD COLUMN isActive TINYINT(1) NOT NULL DEFAULT 1');
    columnCache.set('user.isActive', true);
  }
  if (!(await hasColumn('careprovider', 'approvalStatus'))) {
    await db.query(
      "ALTER TABLE careprovider ADD COLUMN approvalStatus VARCHAR(24) NOT NULL DEFAULT 'pending'",
    );
    columnCache.set('careprovider.approvalStatus', true);
  }
  const careProviderColumns = [
    ['is_rate_approved', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['hourly_rate', 'DECIMAL(10,2) NOT NULL DEFAULT 0'],
    ['status', "VARCHAR(24) NOT NULL DEFAULT 'pending'"],
    ['experience_level', "VARCHAR(24) NOT NULL DEFAULT 'junior'"],
  ];
  for (const [column, definition] of careProviderColumns) {
    if (!(await hasColumn('careprovider', column))) {
      await db.query(`ALTER TABLE careprovider ADD COLUMN ${column} ${definition}`);
      columnCache.set(`careprovider.${column}`, true);
    }
  }
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
}

async function getProviderWorkEligibility(providerId) {
  await ensureProviderWorkColumns();
  await ensureProviderRateAcceptanceColumns();
  const [[row]] = await db.query(
    `SELECT
       u.userId,
       u.role,
       COALESCE(u.isActive, 1) AS isActive,
       COALESCE(cp.approvalStatus, 'pending') AS approvalStatus,
       COALESCE(cp.specialization, 'Home Nursing Care') AS specialization
     FROM user u
     LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY u.userId
     WHERE BINARY u.userId = BINARY ?
     LIMIT 1`,
    [providerId],
  );
  if (!row) {
    return {
      canWork: false,
      reason: 'Provider account not found',
      approvalStatus: 'missing',
      rateAcceptanceStatus: 'missing',
      providerRate: 0,
    };
  }
  const [rateRows] = await db.query(
    `SELECT specialization, provider_hour_rate AS providerRate,
            COALESCE(rateAcceptanceStatus, 'pending') AS rateAcceptanceStatus,
            rateSetAt, rateAcceptedAt, rateRejectedAt
     FROM provider_rates
     WHERE BINARY providerId = BINARY ?
     ORDER BY id DESC
     LIMIT 1`,
    [providerId],
  );
  const rate = rateRows[0] || {};
  const approvalStatus = (row.approvalStatus || 'pending').toString().toLowerCase();
  const rateAcceptanceStatus = (rate.rateAcceptanceStatus || 'pending').toString().toLowerCase();
  const providerRate = Number(rate.providerRate || 0);
  const isActive = row.isActive === 1 || row.isActive === true || row.isActive === '1';
  const canWork =
    isActive &&
    approvalStatus === 'approved' &&
    providerRate > 0 &&
    rateAcceptanceStatus === 'accepted';
  let reason = '';
  if (approvalStatus !== 'approved') {
    reason = 'Admin approval is required before accepting requests';
  } else if (providerRate <= 0) {
    reason = 'Admin must set your hourly rate before you can start working';
  } else if (rateAcceptanceStatus !== 'accepted') {
    reason = 'Please accept your admin-set hourly rate before starting work';
  } else if (!isActive) {
    reason = 'Your account is inactive. Please contact admin.';
  }
  return {
    canWork,
    reason,
    approvalStatus,
    rateAcceptanceStatus,
    providerRate,
    specialization: rate.specialization || row.specialization,
    rateSetAt: rate.rateSetAt,
    rateAcceptedAt: rate.rateAcceptedAt,
    rateRejectedAt: rate.rateRejectedAt,
    isActive: canWork,
  };
}

async function assertProviderCanWork(providerId) {
  const eligibility = await getProviderWorkEligibility(providerId);
  if (!eligibility.canWork) {
    const e = new Error(eligibility.reason || 'Provider is not eligible to work yet');
    e.status = 403;
    e.eligibility = eligibility;
    throw e;
  }
  return eligibility;
}

async function ensurePaymentTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payment (
      paymentId CHAR(36) NOT NULL PRIMARY KEY,
      requestId CHAR(36) NOT NULL,
      patientUserId CHAR(36) NOT NULL,
      providerUserId CHAR(36) NOT NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      paymentMethod VARCHAR(64) NOT NULL DEFAULT 'visa_card',
      paymentStatus VARCHAR(32) NOT NULL DEFAULT 'pending',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payment_request (requestId),
      KEY idx_payment_provider (providerUserId),
      KEY idx_payment_patient (patientUserId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  const additions = [
    ['paymentMethod', `ALTER TABLE payment ADD COLUMN paymentMethod VARCHAR(64) NOT NULL DEFAULT 'visa_card'`],
    ['paymentStatus', `ALTER TABLE payment ADD COLUMN paymentStatus VARCHAR(32) NOT NULL DEFAULT 'pending'`],
    ['createdAt', `ALTER TABLE payment ADD COLUMN createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`],
    ['updatedAt', `ALTER TABLE payment ADD COLUMN updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`],
  ];
  for (const [column, sql] of additions) {
    if (await hasColumn('payment', column)) continue;
    try {
      await db.execute(sql);
      columnCache.set(`payment.${column}`, true);
    } catch (_) {}
  }
  try {
    await db.execute(`ALTER TABLE payment ADD UNIQUE KEY uq_payment_request (requestId)`);
  } catch (_) {}
}

async function ensurePaymentForRequest(requestId) {
  await ensurePaymentTable();
  const hasHourly = await hasColumn('careprovider', 'hourlyRate');
  const hasFee = await hasColumn('careprovider', 'consultationFee');
  const rateExpr =
    hasHourly && hasFee
      ? 'COALESCE(c.hourlyRate, c.consultationFee, 0)'
      : hasHourly
        ? 'COALESCE(c.hourlyRate, 0)'
        : hasFee
          ? 'COALESCE(c.consultationFee, 0)'
          : '0';
  const [rows] = await db.query(
    `SELECT sr.requestId, sr.patientUserId, sr.providerUserId,
            ${rateExpr} AS rate
     FROM servicerequest sr
     LEFT JOIN careprovider c ON c.userId = sr.providerUserId
     WHERE sr.requestId = ?
     LIMIT 1`,
    [requestId],
  );
  if (!rows.length) return;
  const r = rows[0];
  const amount = Number(r.rate || 0) || DEFAULT_VISIT_PAYMENT_AMOUNT;
  await db.execute(
    `INSERT INTO payment
       (paymentId, requestId, patientUserId, providerUserId, amount, paymentMethod, paymentStatus, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'visa_card', 'pending', NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       providerUserId = VALUES(providerUserId),
       patientUserId = VALUES(patientUserId),
       amount = CASE WHEN amount = 0 THEN VALUES(amount) ELSE amount END,
       updatedAt = NOW()`,
    [randomUUID(), r.requestId, r.patientUserId, r.providerUserId, amount],
  );
}

/**
 * SQL expression for the provider's share of a `payment` row. Earnings must
 * never include the admin commission: use the recorded split
 * (`provider_amount`) when present, else the provider's configured hourly
 * rate, else the raw amount — always capped at the amount actually paid.
 */
async function providerShareSqlExpr(alias = 'payment') {
  const a = alias;
  const hasProviderAmount = await hasColumn('payment', 'provider_amount');
  const hasProviderRates = await hasTable('provider_rates');
  const rateSub = hasProviderRates
    ? `(SELECT pr.provider_hour_rate FROM provider_rates pr
        WHERE BINARY pr.providerId = BINARY ${a}.providerUserId
        ORDER BY (pr.rateAcceptanceStatus = 'accepted') DESC, pr.id DESC
        LIMIT 1)`
    : 'NULL';
  const candidates = [];
  if (hasProviderAmount) candidates.push(`NULLIF(${a}.provider_amount, 0)`);
  candidates.push(`NULLIF(${rateSub}, 0)`);
  candidates.push(`${a}.amount`);
  return `LEAST(COALESCE(${candidates.join(', ')}, 0), ${a}.amount)`;
}

async function syncProviderPayments(providerId) {
  const [rows] = await db.query(
    `SELECT requestId
     FROM servicerequest
     WHERE providerUserId = ?
       AND status IN ('confirmed', 'completed')
     ORDER BY scheduledAt DESC
     LIMIT 200`,
    [providerId],
  );
  for (const row of rows) {
    await ensurePaymentForRequest(row.requestId);
  }
}

function toDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const raw = value.toString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  }
  return d.toISOString().slice(0, 10);
}

function mapVisitReportRow(r) {
  const scheduled =
    r.scheduledAt ||
    r.visit_date ||
    (r.created_at ? String(r.created_at).slice(0, 10) : '') ||
    new Date().toISOString();
  return {
    id: r.id,
    requestId: r.appointment_id || '',
    providerId: r.provider_id,
    patientId: r.patient_id,
    patientName: r.patientName || r.manual_patient_name || '',
    serviceType: r.serviceType || '',
    location:
      (r.visitAddress && String(r.visitAddress).trim()) || r.location || '',
    scheduledDate: scheduled,
    durationHours: Number(r.duration_hours || 0),
    visitSummary: r.diagnosis || '',
    vitalSigns: r.vital_signs || '',
    medications: r.medications_prescribed || '',
    observations: r.treatment_plan || '',
    recommendations: r.recommendations || '',
    attachments: parseJsonArray(r.attachment_urls),
    status: 'completed',
    createdAt: r.created_at,
    updatedAt: r.created_at,
  };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch (_) {
    return String(value)
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function mapLegacyVisitReportRow(r) {
  const scheduled =
    r.scheduledAt ||
    r.createdAt ||
    r.created_at ||
    new Date().toISOString();
  return {
    id: `legacy:${r.reportId}`,
    requestId: r.requestId || '',
    providerId: r.providerUserId || '',
    patientId: r.patientUserId || '',
    patientName: r.patientName || '',
    serviceType: r.serviceType || 'Visit Report',
    location: r.location || '',
    scheduledDate: scheduled,
    durationHours: 0,
    visitSummary: r.notes || r.diagnosis || '',
    vitalSigns: '',
    medications: '',
    observations: r.diagnosis || '',
    recommendations: '',
    attachments: [],
    status: 'completed',
    createdAt: scheduled,
    updatedAt: scheduled,
  };
}

router.get('/reports/:providerId', async (req, res) => {
  const { providerId } = req.params;
  try {
    await ensureVisitReportUiColumns();
    const hasMed = await hasColumn('visit_reports', 'medications_prescribed');
    const medSel = hasMed ? 'vr.medications_prescribed' : "'' AS medications_prescribed";
    const hasDuration = await hasColumn('visit_reports', 'duration_hours');
    const durationSel = hasDuration ? 'vr.duration_hours' : '0 AS duration_hours';
    const hasManualName = await hasColumn('visit_reports', 'manual_patient_name');
    const manualNameSel = hasManualName ? 'vr.manual_patient_name' : "'' AS manual_patient_name";
    const hasAttachments = await hasColumn('visit_reports', 'attachment_urls');
    const attachmentsSel = hasAttachments ? 'vr.attachment_urls' : "'' AS attachment_urls";
    const hasVisitAddress = await hasColumn('servicerequest', 'visitAddress');
    const visitAddressSel = hasVisitAddress ? 'sr.visitAddress' : "'' AS visitAddress";

    let [rows] = await db.query(
      `SELECT vr.id, vr.patient_id, vr.provider_id, vr.appointment_id,
              vr.vital_signs, vr.diagnosis, vr.treatment_plan, vr.recommendations,
              ${medSel}, ${durationSel}, ${manualNameSel}, ${attachmentsSel},
              vr.created_at, vr.visit_date,
              u.fullName AS patientName,
              sr.serviceType, sr.location, ${visitAddressSel}, sr.scheduledAt
       FROM visit_reports vr
       LEFT JOIN user u ON BINARY u.userId = BINARY vr.patient_id
       LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY vr.appointment_id
       WHERE BINARY vr.provider_id = BINARY ?
       ORDER BY vr.created_at DESC
       LIMIT 200`,
      [providerId],
    );
    if (!rows.length) {
      [rows] = await db.query(
        `SELECT vr.id, vr.patient_id, vr.provider_id, vr.appointment_id,
                vr.vital_signs, vr.diagnosis, vr.treatment_plan, vr.recommendations,
                ${medSel}, ${durationSel}, ${manualNameSel}, ${attachmentsSel},
                vr.created_at, vr.visit_date,
                u.fullName AS patientName,
                sr.serviceType, sr.location, ${visitAddressSel}, sr.scheduledAt
         FROM visit_reports vr
         LEFT JOIN user u ON BINARY u.userId = BINARY vr.patient_id
         LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY vr.appointment_id
         ORDER BY vr.created_at DESC
         LIMIT 200`,
      );
    }
    let out = rows.map(mapVisitReportRow);
    if (!out.length && (await hasTable('visitreport'))) {
      const [legacyRows] = await db.query(
        `SELECT r.reportId, r.notes, r.diagnosis,
                v.visitId, v.requestId,
                sr.patientUserId, sr.providerUserId, sr.serviceType,
                sr.location, sr.scheduledAt, sr.status,
                u.fullName AS patientName
         FROM visitreport r
         LEFT JOIN visit v ON BINARY v.visitId = BINARY r.visitId
         LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY v.requestId
         LEFT JOIN user u ON BINARY u.userId = BINARY sr.patientUserId
         WHERE BINARY sr.providerUserId = BINARY ?
            OR sr.providerUserId IS NULL
         ORDER BY sr.scheduledAt DESC
         LIMIT 200`,
        [providerId],
      );
      out = legacyRows.map(mapLegacyVisitReportRow);
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reports/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const b = req.body || {};

  const reportId = (b.reportId || b.id || '').toString().trim();
  const patientId = (b.patientId || '').toString().trim();
  const appointmentId = (b.requestId || b.appointmentId || '').toString().trim();
  const serviceType = (b.serviceType || '').toString().trim();
  const location = (b.location || '').toString().trim();
  const scheduledDate = toDateOnly(b.scheduledDate || b.visitDate);
  const durationHours = Number.parseInt(b.durationHours, 10) || 0;
  const visitSummary = (b.visitSummary || '').toString().trim();
  const observations = (b.observations || '').toString().trim();
  const vitalSigns = (b.vitalSigns || '').toString().trim();
  const medications = (b.medications || '').toString().trim();
  const recommendations = (b.recommendations || '').toString().trim();
  const attachments = Array.isArray(b.attachments)
    ? JSON.stringify(b.attachments.map((item) => String(item)))
    : (b.attachments || '').toString().trim();

  try {
    await ensureVisitReportUiColumns();

    if (reportId) {
      if (reportId.startsWith('legacy:')) {
        const legacyId = reportId.substring('legacy:'.length);
        if (!(await hasTable('visitreport'))) {
          return res.status(404).json({ error: 'Legacy report table missing' });
        }
        await db.execute(
          `UPDATE visitreport SET notes = ?, diagnosis = ?
           WHERE BINARY reportId = BINARY ?`,
          [visitSummary || observations, observations || visitSummary, legacyId],
        );
        const [legacyRows] = await db.query(
          `SELECT r.reportId, r.notes, r.diagnosis,
                  v.visitId, v.requestId,
                  sr.patientUserId, sr.providerUserId, sr.serviceType,
                  sr.location, sr.scheduledAt, sr.status,
                  u.fullName AS patientName
           FROM visitreport r
           LEFT JOIN visit v ON BINARY v.visitId = BINARY r.visitId
           LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY v.requestId
           LEFT JOIN user u ON BINARY u.userId = BINARY sr.patientUserId
           WHERE BINARY r.reportId = BINARY ?
           LIMIT 1`,
          [legacyId],
        );
        return res.json(mapLegacyVisitReportRow(legacyRows[0]));
      }
      const hasMedUp = await hasColumn('visit_reports', 'medications_prescribed');
      const hasVisitDateUp = await hasColumn('visit_reports', 'visit_date');
      const hasDurationUp = await hasColumn('visit_reports', 'duration_hours');
      const hasManualNameUp = await hasColumn('visit_reports', 'manual_patient_name');
      const hasAttachmentsUp = await hasColumn('visit_reports', 'attachment_urls');
      const sets = [
        'diagnosis = ?',
        'treatment_plan = ?',
        'vital_signs = ?',
        'recommendations = ?',
      ];
      const vals = [
        visitSummary || observations,
        observations,
        vitalSigns,
        recommendations,
      ];
      if (hasMedUp) {
        sets.push('medications_prescribed = ?');
        vals.push(medications);
      }
      if (hasVisitDateUp && scheduledDate) {
        sets.push('visit_date = ?');
        vals.push(scheduledDate);
      }
      if (hasDurationUp) {
        sets.push('duration_hours = ?');
        vals.push(durationHours);
      }
      if (hasManualNameUp) {
        sets.push('manual_patient_name = ?');
        vals.push((b.patientName || '').toString().trim());
      }
      if (hasAttachmentsUp) {
        sets.push('attachment_urls = ?');
        vals.push(attachments);
      }
      vals.push(reportId, providerId);
      await db.execute(
        `UPDATE visit_reports SET ${sets.join(', ')}
         WHERE BINARY id = BINARY ? AND BINARY provider_id = BINARY ?`,
        vals,
      );
      if (appointmentId && (serviceType || location || scheduledDate)) {
        const requestSets = [];
        const requestVals = [];
        if (serviceType) {
          requestSets.push('serviceType = ?');
          requestVals.push(serviceType);
        }
        if (location) {
          requestSets.push('location = ?');
          requestVals.push(location);
          if (await hasColumn('servicerequest', 'visitAddress')) {
            requestSets.push('visitAddress = ?');
            requestVals.push(location);
          }
        }
        if (scheduledDate) {
          requestSets.push('scheduledAt = ?');
          requestVals.push(`${scheduledDate} 00:00:00`);
        }
        if (requestSets.length) {
          requestVals.push(appointmentId, providerId);
          await db.execute(
            `UPDATE servicerequest SET ${requestSets.join(', ')}
             WHERE BINARY requestId = BINARY ? AND BINARY providerUserId = BINARY ?`,
            requestVals,
          );
        }
      }
      if (appointmentId) {
        await db.execute(
          `UPDATE servicerequest
           SET status = 'completed', completedAt = COALESCE(completedAt, NOW())
           WHERE BINARY requestId = BINARY ? AND BINARY providerUserId = BINARY ?`,
          [appointmentId, providerId],
        );
      }
      const medSelUp = hasMedUp
        ? 'vr.medications_prescribed'
        : "'' AS medications_prescribed";
      const durationSelUp = hasDurationUp
        ? 'vr.duration_hours'
        : '0 AS duration_hours';
      const manualNameSelUp = hasManualNameUp
        ? 'vr.manual_patient_name'
        : "'' AS manual_patient_name";
      const hasVisitAddressUp = await hasColumn('servicerequest', 'visitAddress');
      const hasAttachmentsSelectUp = await hasColumn('visit_reports', 'attachment_urls');
      const visitAddressSelUp = hasVisitAddressUp
        ? 'sr.visitAddress'
        : "'' AS visitAddress";
      const attachmentsSelUp = hasAttachmentsSelectUp
        ? 'vr.attachment_urls'
        : "'' AS attachment_urls";
      const [updated] = await db.query(
        `SELECT vr.id, vr.patient_id, vr.provider_id, vr.vital_signs, vr.diagnosis,
                vr.appointment_id, vr.treatment_plan, vr.recommendations,
                ${medSelUp}, ${durationSelUp}, ${manualNameSelUp}, ${attachmentsSelUp},
                vr.created_at, vr.visit_date, u.fullName AS patientName,
                sr.serviceType, sr.location, ${visitAddressSelUp}, sr.scheduledAt
         FROM visit_reports vr
         LEFT JOIN user u ON BINARY u.userId = BINARY vr.patient_id
         LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY vr.appointment_id
         WHERE BINARY vr.id = BINARY ?`,
        [reportId],
      );
      return res.json(mapVisitReportRow(updated[0]));
    }

    if (!patientId) {
      return res.status(400).json({
        error: 'patientId is required for new reports',
      });
    }

    const okLink = appointmentId
      ? await medicalRecordService.appointmentLinksPatientProvider(
          appointmentId,
          patientId,
          providerId,
        )
      : true;
    if (!okLink) {
      return res.status(400).json({
        error: 'requestId does not match this patient and provider',
      });
    }

    const row = await medicalRecordService.insertVisitReport({
      patient_id: patientId,
      provider_id: providerId,
      appointment_id: appointmentId,
      vital_signs: vitalSigns,
      diagnosis: visitSummary || observations || 'Visit report',
      treatment_plan: observations,
      recommendations,
      follow_up_required: false,
      visit_date: scheduledDate,
      medications_prescribed: medications,
    });
    if (await hasColumn('visit_reports', 'manual_patient_name')) {
      await db.execute(`UPDATE visit_reports SET manual_patient_name = ? WHERE BINARY id = BINARY ?`, [
        (b.patientName || '').toString().trim(),
        row.id,
      ]);
    }
    if (durationHours > 0 && (await hasColumn('visit_reports', 'duration_hours'))) {
      await db.execute(`UPDATE visit_reports SET duration_hours = ? WHERE BINARY id = BINARY ?`, [
        durationHours,
        row.id,
      ]);
    }
    if (attachments && (await hasColumn('visit_reports', 'attachment_urls'))) {
      await db.execute(`UPDATE visit_reports SET attachment_urls = ? WHERE BINARY id = BINARY ?`, [
        attachments,
        row.id,
      ]);
    }
    if (appointmentId) {
      await db.execute(
        `UPDATE servicerequest
         SET status = 'completed', completedAt = COALESCE(completedAt, NOW())
         WHERE BINARY requestId = BINARY ? AND BINARY providerUserId = BINARY ?`,
        [appointmentId, providerId],
      );
      try {
        const [requestRows] = await db.query(
          `SELECT patientUserId FROM servicerequest WHERE BINARY requestId = BINARY ? LIMIT 1`,
          [appointmentId],
        );
        if (requestRows.length) {
          await insertNotification({
            userId: requestRows[0].patientUserId,
            type: 'visit_completed',
            title: 'تم إنهاء الخدمة',
            body: 'تم إرسال تقرير الزيارة وأصبحت الخدمة مكتملة. يمكنك تقييم الممرض الآن.',
            relatedRequestId: appointmentId,
          });
        }
      } catch (_) {}
    }

    const hasMedIns = await hasColumn('visit_reports', 'medications_prescribed');
    const medSelIns = hasMedIns
      ? 'vr.medications_prescribed'
      : "'' AS medications_prescribed";
    const hasDurationIns = await hasColumn('visit_reports', 'duration_hours');
    const durationSelIns = hasDurationIns
      ? 'vr.duration_hours'
      : '0 AS duration_hours';
    const hasVisitAddressIns = await hasColumn('servicerequest', 'visitAddress');
    const visitAddressSelIns = hasVisitAddressIns
      ? 'sr.visitAddress'
      : "'' AS visitAddress";
    const hasManualNameIns = await hasColumn('visit_reports', 'manual_patient_name');
    const manualNameSelIns = hasManualNameIns
      ? 'vr.manual_patient_name'
      : "'' AS manual_patient_name";
    const hasAttachmentsIns = await hasColumn('visit_reports', 'attachment_urls');
    const attachmentsSelIns = hasAttachmentsIns
      ? 'vr.attachment_urls'
      : "'' AS attachment_urls";
    const [full] = await db.query(
      `SELECT vr.id, vr.patient_id, vr.provider_id, vr.vital_signs, vr.diagnosis,
              vr.appointment_id, vr.treatment_plan, vr.recommendations, ${medSelIns},
              ${durationSelIns}, ${manualNameSelIns}, ${attachmentsSelIns}, vr.created_at, vr.visit_date, u.fullName AS patientName,
              sr.serviceType, sr.location, ${visitAddressSelIns}, sr.scheduledAt
       FROM visit_reports vr
       LEFT JOIN user u ON BINARY u.userId = BINARY vr.patient_id
       LEFT JOIN servicerequest sr ON BINARY sr.requestId = BINARY vr.appointment_id
       WHERE BINARY vr.id = BINARY ?`,
      [row.id],
    );
    res.status(201).json(mapVisitReportRow(full[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function ensureEarningsTables() {
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_rates (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      providerId CHAR(36) NOT NULL,
      specialization VARCHAR(100) NOT NULL,
      provider_hour_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      rateAcceptanceStatus ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
      rateSetAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      rateAcceptedAt DATETIME NULL,
      rateRejectedAt DATETIME NULL,
      UNIQUE KEY uq_provider_rate (providerId, specialization)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureProviderRateAcceptanceColumns();
  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_commission (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      specialization VARCHAR(100) NOT NULL,
      serviceType ENUM('doctor','nurse') NOT NULL,
      commission_amount DECIMAL(10,2) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function syncNurseEarnings(providerId) {
  await ensureEarningsTables();
  const [sessions] = await db.query(
    `SELECT
       sr.requestId,
       sr.patientUserId,
       sr.providerUserId,
       COALESCE(sr.serviceType, cp.specialization, 'Nursing Service') AS specialization,
       sr.status,
       sr.scheduledAt,
       sr.completedAt,
       sr.actualDurationMinutes,
       COALESCE(p.provider_amount, 0) AS providerAmount,
       COALESCE(p.amount, 0) AS paidAmount,
       COALESCE(pr.provider_hour_rate, 0) AS configuredRate,
       COALESCE((
         SELECT pr2.provider_hour_rate FROM provider_rates pr2
         WHERE BINARY pr2.providerId = BINARY sr.providerUserId
         ORDER BY (pr2.rateAcceptanceStatus = 'accepted') DESC, pr2.id DESC
         LIMIT 1
       ), 0) AS fallbackRate,
       COALESCE(ac.commission_amount, 0) AS commissionAmount
     FROM servicerequest sr
     LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY sr.providerUserId
     LEFT JOIN payment p ON BINARY p.requestId = BINARY sr.requestId
     LEFT JOIN provider_rates pr
       ON BINARY pr.providerId = BINARY sr.providerUserId
      AND pr.specialization = COALESCE(sr.serviceType, cp.specialization, 'Nursing Service') COLLATE utf8mb4_unicode_ci
     LEFT JOIN admin_commission ac
       ON ac.specialization = COALESCE(sr.serviceType, cp.specialization, 'Nursing Service') COLLATE utf8mb4_unicode_ci
      AND ac.serviceType = 'nurse'
     WHERE BINARY sr.providerUserId = BINARY ?
       AND LOWER(CAST(sr.status AS CHAR)) IN ('completed','done','waiting_report')
     ORDER BY COALESCE(sr.completedAt, sr.scheduledAt) DESC`,
    [providerId],
  );

  let totalEarned = 0;
  const normalizedSessions = sessions.map((row) => {
    const configured = Number(row.configuredRate || 0);
    const fallbackRate = Number(row.fallbackRate || 0);
    const providerAmount = Number(row.providerAmount || 0);
    const paidAmount = Number(row.paidAmount || 0);
    const commission = Number(row.commissionAmount || 0);
    // Provider earns the provider rate only — the admin commission on top of
    // it (paid by the patient) is never part of the nurse's earnings.
    let rate = providerAmount > 0
      ? providerAmount
      : configured > 0
        ? configured
        : fallbackRate;
    if (rate <= 0 && paidAmount > 0) rate = Math.max(0, paidAmount - commission);
    if (paidAmount > 0 && rate > paidAmount) {
      rate = Math.max(0, paidAmount - commission);
    }
    rate = Math.round(rate * 100) / 100;
    totalEarned += rate;
    return {
      sessionId: row.requestId,
      patientId: row.patientUserId,
      specialization: row.specialization || 'Nursing Service',
      status: row.status,
      scheduledAt: row.scheduledAt,
      completedAt: row.completedAt,
      durationMinutes: Number(row.actualDurationMinutes || 60) || 60,
      ratePerSession: rate,
      points: 1,
    };
  });

  // Preserve provider cancellation compensation when the wallet is rebuilt.
  // Refunded payments are excluded from completed-session earnings above.
  const [[cancellationFeesRow]] = await db.query(
    `SELECT COALESCE(SUM(t.provider_share), 0) AS cancellationFees
     FROM transaction_log t
     JOIN payment p ON BINARY p.paymentId = BINARY t.transactionId
     JOIN servicerequest sr ON BINARY sr.requestId = BINARY p.requestId
     WHERE BINARY t.providerId = BINARY ?
       AND t.type = 'payment'
       AND LOWER(CAST(p.paymentStatus AS CHAR)) = 'refunded'
       AND LOWER(CAST(sr.status AS CHAR)) IN ('cancelled', 'canceled')`,
    [providerId],
  );
  totalEarned += Math.max(
    0,
    Number(cancellationFeesRow?.cancellationFees || 0),
  );

  const [[paidRow]] = await db.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS paid
     FROM transaction_log
     WHERE BINARY providerId = BINARY ?
       AND type = 'payout'`,
    [providerId],
  );
  const paidAmount = Math.max(0, Number(paidRow?.paid || 0));
  const pendingAmount = Math.max(0, totalEarned - paidAmount);
  await db.query(
    `INSERT INTO provider_wallet (providerId, total_earned, pending_amount, paid_amount)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_earned = VALUES(total_earned),
       pending_amount = VALUES(pending_amount),
       paid_amount = VALUES(paid_amount)`,
    [providerId, totalEarned, pendingAmount, paidAmount],
  );
  return { sessions: normalizedSessions, totalEarned, paidAmount, pendingAmount };
}

function payoutLabel(status) {
  const value = (status || '').toString().toLowerCase();
  if (value === 'requested') return 'Pending';
  if (value === 'paid') return 'Paid';
  if (value === 'approved') return 'Approved';
  if (value === 'rejected') return 'Rejected';
  return value || 'Pending';
}

router.get('/rate-status/:providerId', async (req, res) => {
  const providerId = (req.params.providerId || '').toString().trim();
  try {
    if (!(await assertNurseUser(providerId, res))) return;
    res.json(await getProviderWorkEligibility(providerId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/rate-status/:providerId/decision', async (req, res) => {
  const providerId = (req.params.providerId || '').toString().trim();
  const decision = (req.body?.decision || '').toString().trim().toLowerCase();
  if (!['accepted', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be accepted or rejected' });
  }
  try {
    if (!(await assertNurseUser(providerId, res))) return;
    await ensureProviderWorkColumns();
    await ensureProviderRateAcceptanceColumns();
    const [[provider]] = await db.query(
      `SELECT COALESCE(specialization, 'Home Nursing Care') AS specialization
       FROM careprovider
       WHERE BINARY userId = BINARY ?
       LIMIT 1`,
      [providerId],
    );
    const [rates] = await db.query(
      `SELECT id, specialization, provider_hour_rate
       FROM provider_rates
       WHERE BINARY providerId = BINARY ?
       ORDER BY id DESC
       LIMIT 1`,
      [providerId],
    );
    if (!rates.length) {
      return res.status(404).json({ error: 'Admin has not set your hourly rate yet' });
    }
    await db.query(
      `UPDATE provider_rates
       SET rateAcceptanceStatus = ?,
           rateAcceptedAt = CASE WHEN ? = 'accepted' THEN NOW() ELSE NULL END,
           rateRejectedAt = CASE WHEN ? = 'rejected' THEN NOW() ELSE NULL END
       WHERE id = ?`,
      [decision, decision, decision, rates[0].id],
    );
    const approved = decision === 'accepted';
    const specialization = rates[0].specialization || provider?.specialization || 'Home Nursing Care';
    const adminRate = Number(rates[0].provider_hour_rate || 0);
    await db.query(
      `INSERT INTO provider_rate_approval (provider_id, specialization, admin_rate, status)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         admin_rate = VALUES(admin_rate),
         status = VALUES(status),
         updated_at = NOW()`,
      [providerId, specialization, adminRate, approved ? 'approved' : 'rejected'],
    );
    await db.query(
      `INSERT INTO rate_approvals (provider_id, admin_rate, status)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         admin_rate = VALUES(admin_rate),
         status = VALUES(status),
         updated_at = NOW()`,
      [providerId, adminRate, approved ? 'approved' : 'rejected'],
    );
    await db.query(
      `UPDATE careprovider
       SET is_rate_approved = ?,
           hourly_rate = ?,
           status = ?
       WHERE BINARY userId = BINARY ?`,
      [approved ? 1 : 0, adminRate, approved ? 'active' : 'inactive', providerId],
    );
    await db.query(
      `UPDATE user SET isActive = ? WHERE BINARY userId = BINARY ?`,
      [approved ? 1 : 0, providerId],
    );
    res.json({ success: true, ...(await getProviderWorkEligibility(providerId)) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/earnings/:providerId', async (req, res) => {
  const { providerId } = req.params;
  try {
    if (!(await assertNurseUser(providerId, res))) return;
    const synced = await syncNurseEarnings(providerId);
    const eligibility = await getProviderWorkEligibility(providerId);
    await ensureAuxTables();
    const [[provider]] = await db.query(
      `SELECT u.userId, u.fullName, u.role, cp.specialization,
              COALESCE(cp.overallRating, 0) AS rating,
              COALESCE(cp.ratingsCount, 0) AS reviews
       FROM user u
       LEFT JOIN careprovider cp ON BINARY cp.userId = BINARY u.userId
       WHERE BINARY u.userId = BINARY ?
       LIMIT 1`,
      [providerId],
    );
    const [methods] = await db.query(
      `SELECT type, details, isDefault
       FROM provider_payment_method
       WHERE BINARY providerUserId = BINARY ?
       ORDER BY isDefault DESC, createdAt DESC
       LIMIT 1`,
      [providerId],
    );
    const [payouts] = await db.query(
      `SELECT payoutId, amount, status, createdAt
       FROM payout_requests
       WHERE BINARY providerId = BINARY ?
       ORDER BY createdAt DESC
       LIMIT 50`,
      [providerId],
    );
    const [transactions] = await db.query(
      `SELECT transactionId, total_amount AS amount, type, createdAt
       FROM transaction_log
       WHERE BINARY providerId = BINARY ?
       ORDER BY createdAt DESC
       LIMIT 50`,
      [providerId],
    );

    const byService = new Map();
    for (const session of synced.sessions) {
      const item = byService.get(session.specialization) || {
        specialization: session.specialization,
        totalSessions: 0,
        totalPoints: 0,
        ratePerSession: session.ratePerSession,
        totalEarnings: 0,
      };
      item.totalSessions += 1;
      item.totalPoints += session.points;
      item.ratePerSession = session.ratePerSession || item.ratePerSession;
      item.totalEarnings += session.ratePerSession;
      byService.set(session.specialization, item);
    }

    res.json({
      provider: {
        id: provider?.userId || providerId,
        name: provider?.fullName || 'Provider',
        role: provider?.role || 'nurse',
        specialty: provider?.specialization || 'Nursing',
        rating: Number(provider?.rating || 0),
        reviews: Number(provider?.reviews || 0),
      },
      wallet: {
        availableBalance: Math.round(synced.pendingAmount * 100) / 100,
        totalEarnings: Math.round(synced.totalEarned * 100) / 100,
        alreadyPaid: Math.round(synced.paidAmount * 100) / 100,
      },
      summary: {
        totalSessions: synced.sessions.length,
        totalPoints: synced.sessions.reduce((sum, item) => sum + item.points, 0),
        totalEarnings: Math.round(synced.totalEarned * 100) / 100,
      },
      eligibility,
      sessions: synced.sessions,
      serviceSummary: Array.from(byService.values()).map((item) => ({
        ...item,
        totalEarnings: Math.round(item.totalEarnings * 100) / 100,
      })),
      paymentMethod: methods[0] || {
        type: 'Bank Transfer',
        details: '**** 1234',
        isDefault: true,
      },
      payoutRequests: payouts.map((row) => ({
        ...row,
        statusLabel: payoutLabel(row.status),
      })),
      transactions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/earnings/:providerId/payout', async (req, res) => {
  const { providerId } = req.params;
  try {
    if (!(await assertNurseUser(providerId, res))) return;
    try {
      await assertProviderCanWork(providerId);
    } catch (err) {
      return res.status(err.status || 403).json({
        error: err.message,
        eligibility: err.eligibility || null,
      });
    }
    const synced = await syncNurseEarnings(providerId);
    const requestedAmount = Number(req.body?.amount || synced.pendingAmount);
    const amount = Math.round(requestedAmount * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'No available balance to request' });
    }
    if (amount > synced.pendingAmount + 0.001) {
      return res.status(409).json({ error: 'Requested amount exceeds available balance' });
    }
    const [[open]] = await db.query(
      `SELECT payoutId FROM payout_requests
       WHERE BINARY providerId = BINARY ?
         AND status IN ('requested','approved')
       LIMIT 1`,
      [providerId],
    );
    if (open) {
      return res.status(409).json({ error: 'You already have a pending payout request' });
    }
    const payoutId = randomUUID();
    await db.query(
      `INSERT INTO payout_requests (payoutId, providerId, amount, status, createdAt)
       VALUES (?, ?, ?, 'requested', NOW())`,
      [payoutId, providerId, amount],
    );
    res.status(201).json({
      success: true,
      payoutId,
      amount,
      status: 'requested',
      statusLabel: 'Pending',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** --- Profile, certs, availability --- */
router.get('/profile/:providerId', async (req, res) => {
  const { providerId } = req.params;
  try {
    await ensureProviderWorkColumns();
    await ensureProviderRateAcceptanceColumns();
    await ensureNurseEditableProfileColumns();
    await ensureAuxTables();
    const hasExp = await hasColumn('careprovider', 'experienceYears');
    const hasYearsSnake = await hasColumn('careprovider', 'years_experience');
    const hasExperienceTier = await hasColumn('careprovider', 'experience_tier');
    const hasExperienceLevel = await hasColumn('careprovider', 'experience_level');
    const hasServiceAreas = await hasColumn('careprovider', 'serviceAreas');
    const hasServiceAreasSnake = await hasColumn('careprovider', 'service_areas');
    const hasBiography = await hasColumn('careprovider', 'biography');
    const hasServiceType = await hasColumn('careprovider', 'serviceType');
    const hasProviderAddress = await hasColumn('careprovider', 'providerAddress');
    const hasHourly = await hasColumn('careprovider', 'hourlyRate');
    const hasFee = await hasColumn('careprovider', 'consultationFee');
    const expSel =
      hasExp && hasYearsSnake
        ? 'COALESCE(c.experienceYears, c.years_experience, 0) AS experienceYears'
        : hasExp
          ? 'COALESCE(c.experienceYears, 0) AS experienceYears'
          : hasYearsSnake
            ? 'COALESCE(c.years_experience, 0) AS experienceYears'
            : '0 AS experienceYears';
    const tierSel =
      hasExperienceTier && hasExperienceLevel
        ? "COALESCE(NULLIF(c.experience_tier, ''), NULLIF(c.experience_level, ''), 'junior') AS experienceTier"
        : hasExperienceTier
          ? "COALESCE(NULLIF(c.experience_tier, ''), 'junior') AS experienceTier"
          : hasExperienceLevel
            ? "COALESCE(NULLIF(c.experience_level, ''), 'junior') AS experienceTier"
            : "'junior' AS experienceTier";
    const serviceAreasSel =
      hasServiceAreas && hasServiceAreasSnake && hasProviderAddress
        ? "COALESCE(NULLIF(c.serviceAreas, ''), NULLIF(c.service_areas, ''), NULLIF(c.providerAddress, ''), '') AS serviceAreas"
        : hasServiceAreas && hasProviderAddress
          ? "COALESCE(NULLIF(c.serviceAreas, ''), NULLIF(c.providerAddress, ''), '') AS serviceAreas"
          : hasServiceAreasSnake && hasProviderAddress
            ? "COALESCE(NULLIF(c.service_areas, ''), NULLIF(c.providerAddress, ''), '') AS serviceAreas"
            : hasProviderAddress
              ? "COALESCE(c.providerAddress, '') AS serviceAreas"
              : hasServiceAreas && hasServiceAreasSnake
                ? "COALESCE(NULLIF(c.serviceAreas, ''), NULLIF(c.service_areas, ''), '') AS serviceAreas"
        : hasServiceAreas
          ? "COALESCE(c.serviceAreas, '') AS serviceAreas"
          : hasServiceAreasSnake
            ? "COALESCE(c.service_areas, '') AS serviceAreas"
            : "'' AS serviceAreas";
    const bioSel =
      hasBiography
          ? "COALESCE(c.biography, '') AS bio"
          : "'' AS bio";
    const rateSel =
      hasHourly && hasFee
        ? 'COALESCE(c.hourlyRate, c.consultationFee, 0) AS hourlyRate'
        : hasHourly
          ? 'COALESCE(c.hourlyRate, 0) AS hourlyRate'
          : hasFee
            ? 'COALESCE(c.consultationFee, 0) AS hourlyRate'
            : '0 AS hourlyRate';

    const hasProfileImageUrl = await hasColumn('user', 'profileImageUrl');
    const profileImageSel = hasProfileImageUrl
      ? 'u.profileImageUrl'
      : 'NULL AS profileImageUrl';

    const [rows] = await db.query(
      `SELECT u.userId AS providerId, u.fullName, u.email, u.phone,
              ${profileImageSel},
              c.specialization, c.isAvailable, c.overallRating,
              COALESCE(c.approvalStatus, 'pending') AS approvalStatus,
              ${serviceAreasSel}, ${bioSel}, ${tierSel}, ${expSel}, ${rateSel},
              pd.medical_certificate, pd.nursing_license, pd.id_card, pd.cv_file
       FROM user u
       JOIN careprovider c ON c.userId = u.userId
       LEFT JOIN provider_documents pd ON BINARY pd.providerUserId = BINARY u.userId
       WHERE BINARY u.userId = BINARY ?
       ORDER BY pd.updatedAt DESC, pd.createdAt DESC
       LIMIT 1`,
      [providerId],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    const r = rows[0];
    const [certs] = await db.query(
      `SELECT name FROM provider_certification WHERE providerUserId = ? ORDER BY createdAt DESC`,
      [providerId],
    );

    const [slots] = await db.query(
      `SELECT day, startTime, endTime FROM availabilityslot WHERE providerUserId = ?`,
      [providerId],
    );
    const availabilitySchedule = {};
    for (const s of slots) {
      availabilitySchedule[s.day] = `${s.startTime}-${s.endTime}`;
    }
    const eligibility = await getProviderWorkEligibility(providerId);

    res.json({
      providerId: r.providerId,
      fullName: r.fullName || '',
      email: r.email || '',
      phone: r.phone || '',
      profileImageUrl: r.profileImageUrl || '',
      bio: (r.bio || '').toString(),
      specialization: r.specialization || '',
      serviceAreas: r.serviceAreas || '',
      experienceTier: r.experienceTier || 'junior',
      approvalStatus: eligibility.approvalStatus || r.approvalStatus || 'pending',
      rateAcceptanceStatus: eligibility.rateAcceptanceStatus || 'pending',
      experienceYears: Number(r.experienceYears || 0),
      hourlyRate: Number(r.hourlyRate || 0),
      rating: Number(r.overallRating || 0),
      isAvailable: r.isAvailable === 1 || r.isAvailable === true,
      canWork: Boolean(eligibility.canWork),
      workGateMessage: eligibility.reason || '',
      nursingLicenseUrl: r.nursing_license || '',
      medicalCertificateUrl: r.medical_certificate || '',
      idCardUrl: r.id_card || '',
      cvFileUrl: r.cv_file || '',
      certifications: certs.map((x) => x.name),
      availabilitySchedule,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/profile/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const b = req.body || {};
  try {
    await ensureNurseEditableProfileColumns();
    const fullName = (b.fullName || '').toString().trim();
    const email = (b.email || '').toString().trim();
    const phone = (b.phone || '').toString().trim();
    const hasProfileImagePayload = Object.prototype.hasOwnProperty.call(
      b,
      'profileImageUrl',
    );
    const profileImageUrl = hasProfileImagePayload
      ? (b.profileImageUrl || '').toString().trim()
      : '';
    const specialization = (b.specialization || '').toString().trim();
    const bio = (b.bio || '').toString().trim();
    const serviceAreas = (b.serviceAreas || b.service_areas || '')
      .toString()
      .trim();
    const experienceYears = Number(b.experienceYears || 0);
    const isAvailable =
      b.isAvailable === true || b.isAvailable === 1 || b.isAvailable === '1';

    if (fullName) {
      await db.execute(`UPDATE user SET fullName = ? WHERE userId = ?`, [
        fullName,
        providerId,
      ]);
    }
    if (email) {
      await db.execute(`UPDATE user SET email = ? WHERE userId = ?`, [
        email,
        providerId,
      ]);
    }
    if (phone) {
      await db.execute(`UPDATE user SET phone = ? WHERE userId = ?`, [
        phone,
        providerId,
      ]);
    }
    if (hasProfileImagePayload) {
      await db.execute(
        `UPDATE user SET profileImageUrl = ? WHERE userId = ?`,
        [profileImageUrl || null, providerId],
      );
    }

    const hasExp = await hasColumn('careprovider', 'experienceYears');
    const hasYearsSnake = await hasColumn('careprovider', 'years_experience');
    const hasServiceAreas = await hasColumn('careprovider', 'serviceAreas');
    const hasServiceAreasSnake = await hasColumn(
      'careprovider',
      'service_areas',
    );
    const hasProviderAddress = await hasColumn('careprovider', 'providerAddress');
    const hasBiography = await hasColumn('careprovider', 'biography');
    const hasServiceType = await hasColumn('careprovider', 'serviceType');
    const sets = ['isAvailable = ?'];
    const vals = [isAvailable ? 1 : 0];
    if (specialization) {
      sets.push('specialization = ?');
      vals.push(specialization);
    }
    if (hasBiography) {
      sets.push('biography = ?');
      vals.push(bio);
    }
    if (hasServiceAreas) {
      sets.push('serviceAreas = ?');
      vals.push(serviceAreas);
    }
    if (hasServiceAreasSnake) {
      sets.push('service_areas = ?');
      vals.push(serviceAreas);
    }
    if (hasProviderAddress) {
      sets.push('providerAddress = ?');
      vals.push(serviceAreas);
    }
    if (hasServiceType && (bio || specialization)) {
      sets.push('serviceType = ?');
      vals.push(bio || specialization);
    }
    if (hasExp) {
      sets.push('experienceYears = ?');
      vals.push(Number.isFinite(experienceYears) ? experienceYears : 0);
    }
    if (hasYearsSnake) {
      sets.push('years_experience = ?');
      vals.push(Number.isFinite(experienceYears) ? experienceYears : 0);
    }
    vals.push(providerId);
    await db.execute(
      `UPDATE careprovider SET ${sets.join(', ')} WHERE userId = ?`,
      vals,
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/certifications/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const name = ((req.body || {}).name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    await ensureAuxTables();
    const certId = randomUUID();
    await db.execute(
      `INSERT INTO provider_certification (certId, providerUserId, name) VALUES (?, ?, ?)`,
      [certId, providerId, name],
    );
    res.status(201).json({ certId, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/availability/:providerId', async (req, res) => {
  const { providerId } = req.params;
  try {
    try {
      await assertProviderCanWork(providerId);
    } catch (err) {
      return res.status(err.status || 403).json({
        error: err.message,
        eligibility: err.eligibility || null,
      });
    }
    await ensureAvailabilitySlotTable();
    const hasDate = await hasColumn('availabilityslot', 'date');
    const [slots] = await db.query(
      `SELECT day,
              ${hasDate ? "DATE_FORMAT(date, '%Y-%m-%d') AS date," : "NULL AS date,"}
              startTime, endTime
       FROM availabilityslot
       WHERE providerUserId = ?
       ORDER BY day, startTime`,
      [providerId],
    );
    res.json(slots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function minutesFromTime(value) {
  const text = (value || '').toString().trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return hour * 60 + minute;
}

function timeFromMinutes(totalMinutes) {
  const minutesInDay = 24 * 60;
  const value = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hour = Math.floor(value / 60).toString().padStart(2, '0');
  const minute = (value % 60).toString().padStart(2, '0');
  return `${hour}:${minute}:00`;
}

function expandHourlyAvailabilitySlot(slot) {
  const day = (slot.day ?? slot['day'] ?? '').toString().trim();
  const date = (slot.date ?? slot['date'] ?? '').toString().trim().slice(0, 10);
  const startTime = (slot.startTime ?? slot['start'] ?? '').toString().trim();
  const endTime = (slot.endTime ?? slot['end'] ?? '').toString().trim();
  const start = minutesFromTime(startTime);
  const end = minutesFromTime(endTime);
  if (!day || start == null || end == null || end <= start) return [];

  const expanded = [];
  for (let cursor = start; cursor < end; cursor += 60) {
    const next = Math.min(cursor + 60, end);
    expanded.push({
      day,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      startTime: timeFromMinutes(cursor),
      endTime: timeFromMinutes(next),
    });
  }
  return expanded;
}

router.put('/availability/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const slots = (req.body || {}).slots;
  if (!Array.isArray(slots)) {
    return res.status(400).json({ error: 'slots array required' });
  }
  const conn = await db.getConnection();
  try {
    await assertProviderCanWork(providerId);
    await ensureAvailabilitySlotTable();
    await conn.beginTransaction();
    const hourlySlots = slots.flatMap(expandHourlyAvailabilitySlot);
    await ensureCareProviderForAvailability(conn, providerId, hourlySlots.length > 0);
    const hasSlotId = await hasColumn('availabilityslot', 'slotId');
    const hasSlotUnderscore = await hasColumn('availabilityslot', 'slot_id');
    const hasDate = await hasColumn('availabilityslot', 'date');
    if (hasSlotId || hasSlotUnderscore) {
      await conn.execute(`DELETE FROM availabilityslot WHERE providerUserId = ? OR providerUserId IS NULL OR providerUserId = ''`, [
        providerId,
      ]);
    } else {
      await conn.execute(`DELETE FROM availabilityslot WHERE providerUserId = ?`, [
        providerId,
      ]);
    }
    for (const s of hourlySlots) {
      const { day, date, startTime, endTime } = s;
      const dateColumn = hasDate ? ', date' : '';
      const datePlaceholder = hasDate ? ', ?' : '';
      const dateValue = hasDate ? [date || null] : [];
      if (hasSlotId) {
        await conn.execute(
          `INSERT INTO availabilityslot (slotId, providerUserId, day${dateColumn}, startTime, endTime)
           VALUES (?, ?, ?${datePlaceholder}, ?, ?)`,
          [randomUUID(), providerId, day, ...dateValue, startTime, endTime],
        );
      } else if (hasSlotUnderscore) {
        await conn.execute(
          `INSERT INTO availabilityslot (slot_id, providerUserId, day${dateColumn}, startTime, endTime)
           VALUES (?, ?, ?${datePlaceholder}, ?, ?)`,
          [randomUUID(), providerId, day, ...dateValue, startTime, endTime],
        );
      } else {
        await conn.execute(
          `INSERT INTO availabilityslot (providerUserId, day${dateColumn}, startTime, endTime)
           VALUES (?, ?${datePlaceholder}, ?, ?)`,
          [providerId, day, ...dateValue, startTime, endTime],
        );
      }
    }
    await conn.commit();
    res.json({ success: true, slots: hourlySlots });
  } catch (err) {
    await conn.rollback();
    console.error('[nurse availability] save failed:', err.message);
    res.status(err.status || 500).json({
      error: err.message,
      eligibility: err.eligibility || null,
    });
  } finally {
    conn.release();
  }
});

/** --- Nurse payout methods / history (lightweight) --- */
router.get('/payment-methods/:providerId', async (req, res) => {
  const { providerId } = req.params;
  try {
    await ensureAuxTables();
    const [rows] = await db.query(
      `SELECT methodId AS id, providerUserId AS providerId, type, details, isDefault
       FROM provider_payment_method WHERE providerUserId = ?`,
      [providerId],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/payment-methods/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const b = req.body || {};
  try {
    await ensureAuxTables();
    const methodId = randomUUID();
    const isDef = b.isDefault === 1 || b.isDefault === true;
    if (isDef) {
      await db.execute(
        `UPDATE provider_payment_method SET isDefault = 0 WHERE providerUserId = ?`,
        [providerId],
      );
    }
    await db.execute(
      `INSERT INTO provider_payment_method (methodId, providerUserId, type, details, isDefault)
       VALUES (?, ?, ?, ?, ?)`,
      [
        methodId,
        providerId,
        (b.type || '').toString(),
        (b.details || '').toString(),
        isDef ? 1 : 0,
      ],
    );
    res.status(201).json({ success: true, id: methodId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/payment-methods/:providerId/:methodId', async (req, res) => {
  const { providerId, methodId } = req.params;
  const b = req.body || {};
  try {
    await ensureAuxTables();
    const isDef = b.isDefault === 1 || b.isDefault === true;
    if (isDef) {
      await db.execute(
        `UPDATE provider_payment_method SET isDefault = 0 WHERE providerUserId = ?`,
        [providerId],
      );
    }
    await db.execute(
      `UPDATE provider_payment_method SET type = ?, details = ?, isDefault = ?
       WHERE methodId = ? AND providerUserId = ?`,
      [
        (b.type || '').toString(),
        (b.details || '').toString(),
        isDef ? 1 : 0,
        methodId,
        providerId,
      ],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/payment-methods/:providerId/:methodId', async (req, res) => {
  const { providerId, methodId } = req.params;
  try {
    await ensureAuxTables();
    await db.execute(
      `DELETE FROM provider_payment_method WHERE methodId = ? AND providerUserId = ?`,
      [methodId, providerId],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments/:providerId', async (req, res) => {
  const { providerId } = req.params;
  try {
    await syncProviderPayments(providerId);
    const queryParts = [];
    const params = [];
    if (await hasTable('payment')) {
      queryParts.push(
        `SELECT p.paymentId AS id, p.providerUserId AS providerId,
                sr.serviceType AS service, pu.fullName AS patientName,
                ${await providerShareSqlExpr('p')} AS amount,
                p.paymentStatus AS status, p.paymentMethod AS paymentMethod,
                p.createdAt AS date
         FROM payment p
         LEFT JOIN servicerequest sr ON sr.requestId = p.requestId
         LEFT JOIN user pu ON pu.userId = p.patientUserId
         WHERE p.providerUserId = ?`
      );
      params.push(providerId);
    }
    if (await hasTable('payments')) {
      queryParts.push(
        `SELECT CAST(p.id AS CHAR(36)) AS id, p.provider_id AS providerId,
                sr.serviceType AS service, pu.fullName AS patientName,
                p.amount, p.status AS status, p.method AS paymentMethod,
                p.created_at AS date
         FROM payments p
         LEFT JOIN servicerequest sr ON sr.requestId = p.appointment_id
         LEFT JOIN user pu ON pu.userId = p.patient_id
         WHERE p.provider_id = ?`
      );
      params.push(providerId);
    }

    let rows = [];
    if (queryParts.length) {
      const [result] = await db.query(
        `SELECT * FROM (
           ${queryParts.join(' UNION ALL ')}
         ) AS allp
         ORDER BY date DESC
         LIMIT 200`,
        params,
      );
      rows = result;
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments/:providerId/summary', async (req, res) => {
  const { providerId } = req.params;
  try {
    await syncProviderPayments(providerId);
    const queryParts = [];
    const params = [];
    if (await hasTable('payment')) {
      queryParts.push(
        `SELECT ${await providerShareSqlExpr()} AS amount, paymentStatus AS status, createdAt
         FROM payment
         WHERE providerUserId = ?`
      );
      params.push(providerId);
    }
    if (await hasTable('payments')) {
      queryParts.push(
        `SELECT amount, status AS status, created_at AS createdAt
         FROM payments
         WHERE provider_id = ?`
      );
      params.push(providerId);
    }

    let m = { monthSum: 0, weekSum: 0, daySum: 0 };
    // Sums below use the provider share only (never the admin commission).
    if (queryParts.length) {
      const [[result]] = await db.query(
        `SELECT
           COALESCE(SUM(CASE
             WHEN YEAR(createdAt) = YEAR(CURDATE()) AND MONTH(createdAt) = MONTH(CURDATE())
             THEN amount ELSE 0 END), 0) AS monthSum,
           COALESCE(SUM(CASE
             WHEN YEARWEEK(createdAt, 1) = YEARWEEK(CURDATE(), 1)
             THEN amount ELSE 0 END), 0) AS weekSum,
           COALESCE(SUM(CASE WHEN DATE(createdAt) = CURDATE() THEN amount ELSE 0 END), 0) AS daySum
         FROM (
           ${queryParts.join(' UNION ALL ')}
         ) AS allp
         WHERE status IN ('paid', 'pending', 'unpaid')`,
        params,
      );
      m = result;
    }
    res.json({
      thisMonth: Number(m?.monthSum || 0),
      thisWeek: Number(m?.weekSum || 0),
      today: Number(m?.daySum || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/payments/:providerId/:transactionId/status', async (req, res) => {
  const { providerId, transactionId } = req.params;
  const st = ((req.body || {}).status || 'paid').toString().toLowerCase();
  try {
    if (await hasTable('payment')) {
      const hasUpdated = await hasColumn('payment', 'updatedAt');
      if (hasUpdated) {
        await db.execute(
          `UPDATE payment SET paymentStatus = ?, updatedAt = NOW()
           WHERE paymentId = ? AND providerUserId = ?`,
          [st, transactionId, providerId],
        );
      } else {
        await db.execute(
          `UPDATE payment SET paymentStatus = ?
           WHERE paymentId = ? AND providerUserId = ?`,
          [st, transactionId, providerId],
        );
      }
      if (st === 'paid') {
        // Persist the provider/admin split so the nurse is credited the
        // provider rate only and the commission stays with the admin.
        try {
          const [[payRow]] = await db.query(
            `SELECT requestId, providerUserId, amount FROM payment
             WHERE paymentId = ? AND providerUserId = ?`,
            [transactionId, providerId],
          );
          if (payRow) {
            await recordPaymentSplit(
              payRow.requestId,
              payRow.providerUserId,
              Number(payRow.amount),
            );
          }
        } catch (_) {}
      }
    }
    if (await hasTable('payments')) {
      await db.execute(
        `UPDATE payments SET status = ?
         WHERE id = ? AND provider_id = ?`,
        [st, transactionId, providerId],
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
