'use strict';

/**
 * CareLink booking payments — uses the **`payment`** table (`requestId` = appointment/booking UUID).
 *
 * DEMO / MOCK: Electronic methods (`mock_card`, `card`, `wallet`) are created **`pending`** and
 * become **`paid`** only via **`confirmDemoPayment`**. Never store card numbers — only method + amounts.
 */

const { randomUUID } = require('crypto');
const db = require('../db');

const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'failed', 'refunded'];
const DEFAULT_VISIT_PAYMENT_AMOUNT = 25;
const DEMO_TX_PREFIX = 'demo_carelink_';

/** @returns {string} */
function paymentCurrency() {
  const c = (
    process.env.CARELINK_PAYMENT_CURRENCY || 'ILS'
  )
    .toString()
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'ILS';
}

const DISALLOWED_KEY_NORM = new Set([
  'cardnumber',
  'ccnumber',
  'ccnum',
  'cvv',
  'cvc',
  'cvc2',
  'pan',
  'trackdata',
  'track1',
  'track2',
  'magstripe',
  'debitcardnumber',
  'creditcardnumber',
  'cardholdername',
  'expirymonth',
  'expiryyear',
  'expirydate',
]);

const columnCache = new Map();
const tableCache = new Map();

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (columnCache.has(key)) return columnCache.get(key);
  try {
    const [rows] = await db.query(
      `SHOW COLUMNS FROM ${tableName} LIKE ?`,
      [columnName],
    );
    const exists = rows.length > 0;
    columnCache.set(key, exists);
    return exists;
  } catch (_) {
    columnCache.set(key, false);
    return false;
  }
}

async function hasTable(tableName) {
  if (tableCache.has(tableName)) return tableCache.get(tableName);
  try {
    const [rows] = await db.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?
       LIMIT 1`,
      [tableName],
    );
    const exists = rows.length > 0;
    tableCache.set(tableName, exists);
    return exists;
  } catch (_) {
    tableCache.set(tableName, false);
    return false;
  }
}

async function ensurePaymentTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payment (
      paymentId CHAR(36) NOT NULL PRIMARY KEY,
      requestId CHAR(36) NOT NULL,
      patientUserId CHAR(36) NOT NULL,
      providerUserId CHAR(36) NOT NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      paymentMethod VARCHAR(64) NOT NULL DEFAULT 'cash',
      paymentStatus VARCHAR(32) NOT NULL DEFAULT 'pending',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payment_request (requestId),
      KEY idx_payment_provider (providerUserId),
      KEY idx_payment_patient (patientUserId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  const additions = [
    ['paymentMethod', `ALTER TABLE payment ADD COLUMN paymentMethod VARCHAR(64) NOT NULL DEFAULT 'cash'`],
    ['paymentStatus', `ALTER TABLE payment ADD COLUMN paymentStatus VARCHAR(32) NOT NULL DEFAULT 'pending'`],
    ['createdAt', `ALTER TABLE payment ADD COLUMN createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`],
    ['updatedAt', `ALTER TABLE payment ADD COLUMN updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`],
    ['transactionId', `ALTER TABLE payment ADD COLUMN transactionId VARCHAR(128) NULL`],
    ['paidAt', `ALTER TABLE payment ADD COLUMN paidAt DATETIME NULL`],
    ['currency', `ALTER TABLE payment ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT '${paymentCurrency().replace(/'/g, "''")}'`],
  ];
  for (const [column, sql] of additions) {
    if (await hasColumn('payment', column)) continue;
    try {
      await db.execute(sql);
      columnCache.set(`payment.${column}`, true);
    } catch (_) {}
  }
  try {
    await db.execute(
      `ALTER TABLE payment ADD UNIQUE KEY uq_payment_request (requestId)`,
    );
  } catch (_) {}
}

function assertNoSensitivePaymentKeys(body) {
  for (const k of Object.keys(body || {})) {
    const n = k.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (DISALLOWED_KEY_NORM.has(n)) return false;
  }
  return true;
}

function toStatus(value, allowed, fallback) {
  const normalized = (value || '').toString().trim().toLowerCase();
  if (allowed.includes(normalized)) return normalized;
  return fallback;
}

/**
 * Canonical CareLink pricing:
 *   providerAmount   = providerRate                     (never reduced by commission)
 *   commissionAmount = providerRate * (commissionPct/100) — stored pre-computed in
 *                      admin_commission.commission_amount
 *   patientTotal     = providerRate + commissionAmount
 * Returns `{ providerRate, commissionAmount, patientTotal }` or null when no
 * accepted provider rate exists.
 */
async function resolvePriceBreakdown(requestId, providerUserId) {
  const hasProviderRates = await hasTable('provider_rates');
  if (!hasProviderRates) return null;
  const hasAdminCommission = await hasTable('admin_commission');
  {
    const commissionJoin = hasAdminCommission
      ? `LEFT JOIN admin_commission ac
           ON ac.specialization = pr.specialization COLLATE utf8mb4_unicode_ci
          AND ac.serviceType = CASE WHEN u.role = 'doctor' THEN 'doctor' ELSE 'nurse' END`
      : '';
    const commissionExpr = hasAdminCommission
      ? 'COALESCE(ac.commission_amount, 0)'
      : '0';
    const [rateRows] = await db.query(
      `SELECT
         pr.provider_hour_rate AS providerRate,
         ${commissionExpr} AS adminCommission,
         (pr.provider_hour_rate + ${commissionExpr}) AS patientPrice
       FROM servicerequest sr
       LEFT JOIN user u ON BINARY u.userId = BINARY sr.providerUserId
       LEFT JOIN careprovider c ON BINARY c.userId = BINARY sr.providerUserId
       JOIN provider_rates pr
         ON BINARY pr.providerId = BINARY sr.providerUserId
       ${commissionJoin}
       WHERE BINARY sr.requestId = BINARY ?
         AND BINARY sr.providerUserId = BINARY ?
         AND pr.rateAcceptanceStatus = 'accepted'
       ORDER BY
         (pr.specialization = COALESCE(c.specialization, sr.serviceType, pr.specialization) COLLATE utf8mb4_unicode_ci) DESC,
         pr.id DESC
       LIMIT 1`,
      [requestId, providerUserId],
    );
    const providerRate = Number(rateRows[0]?.providerRate || 0);
    const commissionAmount = Math.max(0, Number(rateRows[0]?.adminCommission || 0));
    if (Number.isFinite(providerRate) && providerRate > 0) {
      return {
        providerRate: Math.round(providerRate * 100) / 100,
        commissionAmount: Math.round(commissionAmount * 100) / 100,
        patientTotal: Math.round((providerRate + commissionAmount) * 100) / 100,
      };
    }
  }
  return null;
}

async function resolveServerAmount(requestId, providerUserId) {
  const breakdown = await resolvePriceBreakdown(requestId, providerUserId);
  if (breakdown && breakdown.patientTotal > 0) return breakdown.patientTotal;

  const hasHourly = await hasColumn('careprovider', 'hourlyRate');
  const hasFee = await hasColumn('careprovider', 'consultationFee');
  const rateExpr = hasHourly && hasFee
    ? 'COALESCE(c.hourlyRate, c.consultationFee, 0)'
    : hasHourly
      ? 'COALESCE(c.hourlyRate, 0)'
      : hasFee
        ? 'COALESCE(c.consultationFee, 0)'
        : '0';
  const [rows] = await db.query(
    `SELECT ${rateExpr} AS rate
     FROM servicerequest sr
     LEFT JOIN careprovider c ON c.userId = sr.providerUserId
     WHERE sr.requestId = ? AND sr.providerUserId = ?
     LIMIT 1`,
    [requestId, providerUserId],
  );
  if (!rows.length) return 0;
  const r = Number(rows[0]?.rate || 0);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.round(r * 100) / 100;
}

async function syncServiceRequestPayment(appointmentId, method, status) {
  const hasPaymentMethodCol = await hasColumn('servicerequest', 'paymentMethod');
  const hasPaymentStatusCol = await hasColumn('servicerequest', 'paymentStatus');
  if (!hasPaymentMethodCol && !hasPaymentStatusCol) return;

  const updates = [];
  const vals = [];
  if (hasPaymentMethodCol) {
    updates.push('paymentMethod = ?');
    vals.push(method);
  }
  if (hasPaymentStatusCol) {
    updates.push('paymentStatus = ?');
    vals.push(status);
  }
  if (!updates.length) return;
  vals.push(appointmentId);
  await db.execute(
    `UPDATE servicerequest SET ${updates.join(', ')} WHERE requestId = ?`,
    vals,
  );
}

function normalizeElectronicMethod(raw) {
  const m = (raw || '').toString().trim().toLowerCase();
  if (m === 'mock_card' || m === 'mock-card') return 'mock_card';
  if (m === 'card' || m === 'wallet') return m;
  return m;
}

function isCashLike(m) {
  return m === 'cash' || m === 'cash_on_visit';
}

/**
 * Resolve final charge amount:
 * — If DB has provider rate > 0, **always use server-side price** (ignore client manipulation).
 * — Else use client's amount if finite and ≥ 0, capped at 100 000.
 */
async function resolveFinalAmount(requestId, providerUserId, clientAmountHint) {
  const serverAmt = await resolveServerAmount(requestId, providerUserId);
  if (serverAmt > 0) return serverAmt;

  const hint = Number(clientAmountHint);
  if (!Number.isFinite(hint) || hint < 0) return DEFAULT_VISIT_PAYMENT_AMOUNT;
  return Math.min(Math.round(hint * 100) / 100, 100000);
}

async function createApiPayment(body) {
  if (!assertNoSensitivePaymentKeys(body)) {
    throw httpError(
      400,
      'Sensitive payment data must not be sent to this API. Use a gateway token/TLS instead.',
    );
  }

  const appointmentId = (body.appointmentId ?? body.bookingId ?? '')
    .toString()
    .trim();
  const patientUserId = (body.patientUserId ?? body.patientId ?? '')
    .toString()
    .trim();
  const providerClaim = (
    body.providerUserId ??
    body.providerId ??
    ''
  )
    .toString()
    .trim();

  const paymentMethodRaw = (body.paymentMethod ?? body.method ?? 'mock_card')
    .toString()
    .trim();

  if (!appointmentId || !patientUserId) {
    throw httpError(400, 'appointmentId (or bookingId) and patientUserId are required');
  }

  await ensurePaymentTable();
  const hasTransactionId = await hasColumn('payment', 'transactionId');
  const hasPaidAt = await hasColumn('payment', 'paidAt');
  const hasCurrency = await hasColumn('payment', 'currency');

  const [appointments] = await db.query(
    `SELECT requestId, patientUserId, providerUserId, status
     FROM servicerequest WHERE requestId = ? AND patientUserId = ?`,
    [appointmentId, patientUserId],
  );

  if (appointments.length === 0) {
    throw httpError(
      404,
      'Appointment not found or does not belong to this patient',
    );
  }
  const row = appointments[0];
  if (providerClaim && providerClaim !== row.providerUserId) {
    throw httpError(400, 'providerUserId does not match this booking');
  }
  const providerUserId = row.providerUserId;

  const canceled = ['cancelled', 'canceled'].includes(
    (row.status || '').toString().toLowerCase(),
  );
  if (canceled) {
    throw httpError(409, 'Cannot create payment for a cancelled appointment');
  }
  const normalizedMethod = normalizeElectronicMethod(paymentMethodRaw);
  const methodFinal = isCashLike(normalizedMethod)
    ? normalizedMethod === 'cash_on_visit'
      ? 'cash_on_visit'
      : 'cash'
    : normalizedMethod;

  const electronic = ['mock_card', 'card', 'wallet'].includes(methodFinal);
  if (!electronic && !isCashLike(methodFinal)) {
    throw httpError(
      400,
      'paymentMethod must be mock_card, card, wallet, cash, or cash_on_visit',
    );
  }
  let statusInsert = 'pending';
  if (isCashLike(methodFinal)) statusInsert = 'unpaid';

  const finalAmount = await resolveFinalAmount(
    appointmentId,
    providerUserId,
    body.amount ?? body.clientAmountHint,
  );

  const currency = paymentCurrency();

  const [existingRows] = await db.query(
    `SELECT paymentId, paymentStatus, paymentMethod FROM payment WHERE requestId = ?`,
    [appointmentId],
  );

  if (existingRows.length > 0) {
    const ex = existingRows[0];
    if ((ex.paymentStatus || '').toLowerCase() === 'paid') {
      return {
        demo: true,
        success: true,
        alreadyPaid: true,
        paymentId: ex.paymentId,
        appointmentId,
        bookingId: appointmentId,
        patientUserId,
        providerUserId,
        amount: finalAmount,
        currency,
        paymentMethod: ex.paymentMethod,
        paymentStatus: 'paid',
        message: 'Payment was already completed; the existing payment was reused.',
      };
    }

    if (hasTransactionId && hasPaidAt) {
      const params = [
        finalAmount,
        methodFinal,
        statusInsert,
        ...(hasCurrency ? [currency] : []),
        patientUserId,
        providerUserId,
        appointmentId,
      ];
      await db.execute(
        `UPDATE payment SET
          amount = ?, paymentMethod = ?, paymentStatus = ?,
          transactionId = NULL, paidAt = NULL,
          ${hasCurrency ? 'currency = ?, ' : ''}
          patientUserId = ?, providerUserId = ?, updatedAt = NOW()
         WHERE requestId = ?`,
        params,
      );
    } else {
      const params = [
        finalAmount,
        methodFinal,
        statusInsert,
        ...(hasCurrency ? [currency] : []),
        patientUserId,
        providerUserId,
        appointmentId,
      ];
      await db.execute(
        `UPDATE payment SET
          amount = ?, paymentMethod = ?, paymentStatus = ?,
          ${hasCurrency ? 'currency = ?, ' : ''}
          patientUserId = ?, providerUserId = ?, updatedAt = NOW()
         WHERE requestId = ?`,
        params,
      );
    }

    await syncServiceRequestPayment(appointmentId, methodFinal, statusInsert);

    return {
      demo: true,
      mode: electronic ? 'create_pending_then_confirm' : 'cash_manual',
      paymentId: ex.paymentId,
      appointmentId,
      bookingId: appointmentId,
      patientUserId,
      providerUserId,
      amount: finalAmount,
      currency,
      paymentMethod: methodFinal,
      paymentStatus: statusInsert,
      message: electronic
        ? 'Payment record saved as pending — call POST /api/payments/confirm to complete DEMO checkout.'
        : 'Cash-style payment logged as unpaid until collected at visit.',
    };
  }

  const paymentId = randomUUID();
  const placeholders = [
    paymentId,
    appointmentId,
    patientUserId,
    providerUserId,
    finalAmount,
    methodFinal,
    statusInsert,
  ];

  if (hasCurrency && hasTransactionId && hasPaidAt) {
    await db.execute(
      `INSERT INTO payment
       (paymentId, requestId, patientUserId, providerUserId, amount, currency, paymentMethod, paymentStatus, transactionId, paidAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NOW(), NOW())`,
      [...placeholders.slice(0, 5), currency, ...placeholders.slice(5)],
    );
  } else if (hasCurrency) {
    await db.execute(
      `INSERT INTO payment
       (paymentId, requestId, patientUserId, providerUserId, amount, currency, paymentMethod, paymentStatus, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [...placeholders.slice(0, 5), currency, ...placeholders.slice(5)],
    );
  } else if (hasTransactionId && hasPaidAt) {
    await db.execute(
      `INSERT INTO payment
       (paymentId, requestId, patientUserId, providerUserId, amount, paymentMethod, paymentStatus, transactionId, paidAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NOW(), NOW())`,
      placeholders,
    );
  } else {
    await db.execute(
      `INSERT INTO payment
       (paymentId, requestId, patientUserId, providerUserId, amount, paymentMethod, paymentStatus, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      placeholders,
    );
  }

  await syncServiceRequestPayment(appointmentId, methodFinal, statusInsert);

  return {
    demo: true,
    mode: electronic ? 'create_pending_then_confirm' : 'cash_manual',
    paymentId,
    appointmentId,
    bookingId: appointmentId,
    patientUserId,
    providerUserId,
    amount: finalAmount,
    currency,
    paymentMethod: methodFinal,
    paymentStatus: statusInsert,
    message: electronic
      ? 'DEMO: payment pending — call POST /api/payments/confirm to mark paid.'
      : 'Recorded as unpaid (cash-style).',
  };
}

/**
 * Persist the provider/admin split on the payment row:
 *   provider_amount = provider rate (exact hourly amount owed to the provider)
 *   admin_amount    = patientTotal - provider rate (the commission)
 * Leaves the escrow `status` column untouched so the admin finance ledger
 * still credits wallets/transaction_log with these same figures later.
 */
async function recordPaymentSplit(requestId, providerUserId, paidTotal) {
  const hasProviderAmount = await hasColumn('payment', 'provider_amount');
  const hasAdminAmount = await hasColumn('payment', 'admin_amount');
  const hasFinalAmount = await hasColumn('payment', 'final_amount');
  if (!hasProviderAmount || !hasAdminAmount) return null;

  const total = Math.round(Math.max(0, Number(paidTotal) || 0) * 100) / 100;
  if (total <= 0) return null;

  const breakdown = await resolvePriceBreakdown(requestId, providerUserId);
  let providerAmount;
  if (breakdown && breakdown.providerRate > 0) {
    providerAmount = Math.min(breakdown.providerRate, total);
  } else {
    const commission = Math.max(0, Number(breakdown?.commissionAmount || 0));
    providerAmount = Math.max(0, total - commission);
  }
  providerAmount = Math.round(providerAmount * 100) / 100;
  const adminAmount = Math.round((total - providerAmount) * 100) / 100;

  await db.execute(
    `UPDATE payment
     SET provider_amount = ?, admin_amount = ?${hasFinalAmount ? ', final_amount = ?' : ''},
         updatedAt = NOW()
     WHERE requestId = ?`,
    hasFinalAmount
      ? [providerAmount, adminAmount, total, requestId]
      : [providerAmount, adminAmount, requestId],
  );
  return { providerAmount, adminAmount, total };
}

async function confirmDemoPayment(body) {
  if (!assertNoSensitivePaymentKeys(body)) {
    throw httpError(
      400,
      'Sensitive payment data must not be sent to this API.',
    );
  }
  const appointmentId = (body.appointmentId ?? body.bookingId ?? '').toString().trim();
  const patientUserId = (body.patientUserId ?? body.patientId ?? '').toString().trim();

  if (!appointmentId || !patientUserId) {
    throw httpError(400, 'appointmentId and patientUserId are required');
  }

  await ensurePaymentTable();
  const hasTransactionId = await hasColumn('payment', 'transactionId');
  const hasPaidAt = await hasColumn('payment', 'paidAt');

  const [rows] = await db.query(
    `SELECT p.paymentId, p.paymentMethod, p.paymentStatus, p.amount,
            p.providerUserId,
            sr.status AS requestStatus
     FROM payment p
     JOIN servicerequest sr ON sr.requestId = p.requestId
     WHERE p.requestId = ? AND p.patientUserId = ?
     LIMIT 1`,
    [appointmentId, patientUserId],
  );

  if (!rows.length) throw httpError(404, 'No payment record found for this appointment');

  const p = rows[0];
  if ((p.paymentStatus || '').toLowerCase() === 'paid') {
    return {
      demo: true,
      success: true,
      alreadyPaid: true,
      paymentId: p.paymentId,
      appointmentId,
      paymentStatus: 'paid',
      message: 'Payment was already confirmed.',
    };
  }

  const method = (p.paymentMethod || '').toLowerCase();
  if (isCashLike(method)) {
    throw httpError(
      400,
      'Cash payments are finalized at visit — DEMO confirm applies to card/mock/wallet only.',
    );
  }

  const txn = `${DEMO_TX_PREFIX}${randomUUID().replace(/-/g, '')}`;

  if (hasTransactionId && hasPaidAt) {
    await db.execute(
      `UPDATE payment SET paymentStatus = 'paid', transactionId = ?, paidAt = NOW(), updatedAt = NOW()
       WHERE paymentId = ?`,
      [txn, p.paymentId],
    );
  } else {
    await db.execute(
      `UPDATE payment SET paymentStatus = 'paid', updatedAt = NOW()
       WHERE paymentId = ?`,
      [p.paymentId],
    );
  }

  // Record the provider/admin split immediately so provider earnings never
  // absorb the admin commission. Canonical rule:
  //   provider gets the full provider rate; admin gets patientTotal - rate.
  await recordPaymentSplit(appointmentId, p.providerUserId, Number(p.amount));

  await syncServiceRequestPayment(appointmentId, method, 'paid');
  await db.execute(
    `UPDATE servicerequest
     SET status = 'confirmed'
     WHERE requestId = ?
       AND LOWER(TRIM(CAST(status AS CHAR(64)))) IN ('pending_payment', 'payment_pending')`,
    [appointmentId],
  );

  return {
    demo: true,
    success: true,
    transactionId: hasTransactionId ? txn : undefined,
    paymentId: p.paymentId,
    appointmentId,
    bookingId: appointmentId,
    amount: Number(p.amount),
    currency: paymentCurrency(),
    paymentStatus: 'paid',
    message: 'DEMO: payment marked paid (no real money moved).',
  };
}

async function getAppointmentPayment(appointmentId, patientUserId) {
  await ensurePaymentTable();

  const [apptRows] = await db.query(
    `SELECT sr.requestId, sr.patientUserId, sr.providerUserId
     FROM servicerequest sr
     WHERE sr.requestId = ? AND sr.patientUserId = ?`,
    [appointmentId, patientUserId],
  );
  if (!apptRows.length) throw httpError(404, 'Appointment not found');

  const provId = apptRows[0].providerUserId;
  const expected = await resolveFinalAmount(
    appointmentId,
    provId,
    DEFAULT_VISIT_PAYMENT_AMOUNT,
  );

  const [payRows] = await db.query(
    `SELECT paymentId, requestId AS appointmentId, patientUserId, providerUserId,
            amount, final_amount AS finalAmount,
            provider_amount AS providerAmount, admin_amount AS adminAmount,
            status AS escrowStatus, paymentMethod, paymentStatus,
            transactionId, paidAt, createdAt, updatedAt
     FROM payment WHERE requestId = ?`,
    [appointmentId],
  );

  const cur = paymentCurrency();

  if (!payRows.length) {
    return {
      demo: true,
      exists: false,
      appointmentId,
      patientUserId,
      providerUserId: provId,
      expectedAmount: expected,
      currency: cur,
      paymentStatus: null,
      canPay: true,
      message:
        'No payment row yet — use POST /api/payments/create to start DEMO checkout.',
    };
  }

  const pr = payRows[0];
  const paid = String(pr.paymentStatus || '').toLowerCase() === 'paid';
  const totalAmount = Number(pr.finalAmount ?? pr.amount ?? 0);
  const providerShare = Number(pr.providerAmount || 0);
  const adminShare = Number(pr.adminAmount || 0);
  const refunded = String(pr.paymentStatus || '').toLowerCase() === 'refunded';
  const refundAmount = refunded
    ? Math.max(
        0,
        Math.round((totalAmount - providerShare - adminShare) * 100) / 100,
      )
    : 0;

  return {
    demo: true,
    exists: true,
    paymentId: pr.paymentId,
    appointmentId: pr.appointmentId,
    bookingId: pr.appointmentId,
    patientUserId: pr.patientUserId,
    providerUserId: pr.providerUserId,
    amount: Number(pr.amount),
    finalAmount: totalAmount,
    providerAmount: providerShare,
    adminAmount: adminShare,
    refundAmount,
    escrowStatus: pr.escrowStatus,
    currency: cur,
    paymentMethod: pr.paymentMethod,
    paymentStatus: pr.paymentStatus,
    transactionId: pr.transactionId,
    paidAt: pr.paidAt,
    updatedAt: pr.updatedAt,
    canPay: !paid && !['cancelled', 'canceled'].includes(await appointmentStatusQuick(appointmentId)),
  };
}

async function appointmentStatusQuick(id) {
  const [rows] = await db.query(
    `SELECT status FROM servicerequest WHERE requestId = ?`,
    [id],
  );
  return (rows[0]?.status || '').toLowerCase();
}

async function listPatientPayments(patientUserId) {
  await ensurePaymentTable();
  const cur = paymentCurrency();
  const [rows] = await db.query(
    `SELECT
        p.paymentId,
        p.requestId AS appointmentId,
        p.requestId AS bookingId,
        ? AS currency,
        p.amount,
        p.final_amount AS finalAmount,
        p.provider_amount AS providerAmount,
        p.admin_amount AS adminAmount,
        p.paymentMethod,
        p.paymentStatus,
        p.transactionId,
        p.paidAt,
        p.createdAt,
        sr.scheduledAt,
        u.fullName AS providerName
     FROM payment p
     LEFT JOIN servicerequest sr ON p.requestId = sr.requestId
     LEFT JOIN user u ON p.providerUserId = u.userId
     WHERE p.patientUserId = ?
     ORDER BY p.createdAt DESC`,
    [cur, patientUserId],
  );
  return rows.map((row) => {
    const totalAmount = Number(row.finalAmount ?? row.amount ?? 0);
    const providerShare = Number(row.providerAmount || 0);
    const adminShare = Number(row.adminAmount || 0);
    const refunded = String(row.paymentStatus || '').toLowerCase() === 'refunded';
    return {
      ...row,
      finalAmount: totalAmount,
      providerAmount: providerShare,
      adminAmount: adminShare,
      refundAmount: refunded
        ? Math.max(
            0,
            Math.round((totalAmount - providerShare - adminShare) * 100) / 100,
          )
        : 0,
    };
  });
}

/** Mirrors legacy `POST /patient/payments` behaviour (existing mobile clients). */
async function createLegacyPatientPayment(body) {
  const {
    appointmentId,
    patientUserId,
    providerUserId,
    amount,
    paymentMethod,
    status,
  } = body || {};

  if (!assertNoSensitivePaymentKeys(body)) {
    throw httpError(
      400,
      'Sensitive payment data must not be sent to this API. Use TLS and a PCI-compliant provider; only method and amount are stored here.',
    );
  }

  if (
    !appointmentId ||
    !patientUserId ||
    !providerUserId ||
    amount == null ||
    !paymentMethod
  ) {
    throw httpError(
      400,
      'appointmentId, patientUserId, providerUserId, amount and paymentMethod are required',
    );
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
    throw httpError(400, 'amount must be a valid number');
  }

  const normalizedMethod = paymentMethod.toString().trim().toLowerCase();
  const allowZero =
    normalizedMethod === 'cash' ||
    normalizedMethod === 'card' ||
    normalizedMethod === 'cash_on_visit';
  if (!allowZero && parsedAmount <= 0) {
    throw httpError(400, 'amount must be a positive number');
  }

  await ensurePaymentTable();
  const hasPaymentMethodSr = await hasColumn('servicerequest', 'paymentMethod');
  const hasPaymentStatusSr = await hasColumn('servicerequest', 'paymentStatus');
  const hasTransactionId = await hasColumn('payment', 'transactionId');
  const hasPaidAt = await hasColumn('payment', 'paidAt');

  const [appointments] = await db.query(
    `SELECT requestId
     FROM servicerequest
     WHERE requestId = ? AND patientUserId = ? AND providerUserId = ?`,
    [appointmentId, patientUserId, providerUserId],
  );

  if (appointments.length === 0) {
    throw httpError(404, 'Related appointment not found');
  }

  const [existingPayment] = await db.query(
    'SELECT paymentId FROM payment WHERE requestId = ?',
    [appointmentId],
  );

  if (existingPayment.length > 0) {
    throw httpError(409, 'Payment already exists for this appointment');
  }

  const serverAmt = await resolveServerAmount(
    appointmentId,
    providerUserId,
  );
  const finalAmount =
    serverAmt > 0 ? serverAmt : Math.round(parsedAmount * 100) / 100;

  const computedStatus = status
    ? toStatus(status, PAYMENT_STATUSES, 'unpaid')
    : normalizedMethod === 'cash' || normalizedMethod === 'cash_on_visit'
      ? 'unpaid'
      : normalizedMethod === 'card'
        ? 'pending'
        : 'paid';

  const paymentId = randomUUID();
  const baseParams = [
    paymentId,
    appointmentId,
    patientUserId,
    providerUserId,
    finalAmount,
    normalizedMethod,
    computedStatus,
  ];

  if (hasTransactionId && hasPaidAt) {
    await db.execute(
      `INSERT INTO payment
       (paymentId, requestId, patientUserId, providerUserId, amount, paymentMethod, paymentStatus, transactionId, paidAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NOW(), NOW())`,
      baseParams,
    );
  } else {
    await db.execute(
      `INSERT INTO payment
       (paymentId, requestId, patientUserId, providerUserId, amount, paymentMethod, paymentStatus, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      baseParams,
    );
  }

  if (computedStatus === 'paid') {
    try {
      await recordPaymentSplit(appointmentId, providerUserId, finalAmount);
    } catch (_) {}
  }

  if (hasPaymentMethodSr || hasPaymentStatusSr) {
    const updates = [];
    const updateValues = [];
    if (hasPaymentMethodSr) {
      updates.push('paymentMethod = ?');
      updateValues.push(normalizedMethod);
    }
    if (hasPaymentStatusSr) {
      updates.push('paymentStatus = ?');
      updateValues.push(computedStatus);
    }
    if (updates.length) {
      updateValues.push(appointmentId);
      await db.execute(
        `UPDATE servicerequest SET ${updates.join(', ')} WHERE requestId = ?`,
        updateValues,
      );
    }
  }

  return {
    message: 'Payment stored successfully',
    paymentId,
    appointmentId,
    bookingId: appointmentId,
    paymentStatus: computedStatus,
    amount: finalAmount,
    currency: paymentCurrency(),
    demoAmountSource: serverAmt > 0 ? 'provider_rate' : 'client_supplied_or_default',
  };
}

module.exports = {
  recordPaymentSplit,
  resolvePriceBreakdown,
  createApiPayment,
  confirmDemoPayment,
  getAppointmentPayment,
  listPatientPayments,
  createLegacyPatientPayment,
  assertNoSensitivePaymentKeys,
  ensurePaymentTable,
};
