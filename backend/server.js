require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const dbService = require('./firebase-config');
const { sendRealSmsOtp } = require('./services/smsService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend files from ../frontend directory
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));
app.use('/public', express.static(path.join(frontendPath, 'public')));

// Temporary OTP Store: phone -> { code, expiresAt, verified }
const otpStore = new Map();

// Helper Validations
const validateName = (name) => {
  if (!name || typeof name !== 'string') return false;
  return !/\d/.test(name) && name.trim().length >= 2;
};

const validateEmail = (email) => {
  if (!email) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
};

const validateWebsite = (website) => {
  if (!website) return false;
  const clean = website.trim();
  const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/[^\s]*)?$/;
  return urlRegex.test(clean);
};

/* ==========================================================================
   API ROUTES
   ========================================================================== */

// 1. Production Real SMS OTP Dispatch Endpoint
app.post('/api/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.trim().length < 6) {
    return res.status(400).json({ success: false, message: 'Valid phone number with country code is required' });
  }

  const rawDigits = phone.replace(/[^0-9]/g, '').slice(-10);
  const cleanPhone = (phone.trim().startsWith('+') ? '' : '+') + phone.trim().replace(/[\s\-()]/g, '');
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 mins

  const recordData = { code, expiresAt, verified: false, fullPhone: cleanPhone };
  otpStore.set(cleanPhone, recordData);
  otpStore.set(rawDigits, recordData);

  console.log(`=======================================================`);
  console.log(`📱 [OTP GENERATED] Phone: ${cleanPhone} (${rawDigits}) | Code: ${code}`);
  console.log(`=======================================================`);

  // Dispatch via Production Real SMS Service
  const smsResult = await sendRealSmsOtp(cleanPhone, code);

  return res.json({
    success: true,
    message: smsResult.success 
      ? `Real SMS OTP dispatched to ${cleanPhone} via ${smsResult.provider}` 
      : `OTP generated for ${cleanPhone}`,
    otpCode: code,
    smsSent: smsResult.success,
    provider: smsResult.provider || 'Console Logger',
    error: smsResult.error
  });
});

// 2. Verify OTP
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'Phone and OTP are required' });
  }

  const rawDigits = phone.replace(/[^0-9]/g, '').slice(-10);
  const cleanPhone = (phone.trim().startsWith('+') ? '' : '+') + phone.trim().replace(/[\s\-()]/g, '');
  
  // Lookup by full phone or 10-digit fallback
  let record = otpStore.get(cleanPhone) || otpStore.get(rawDigits);

  if (!record) {
    return res.status(400).json({ success: false, message: 'No OTP requested for this phone number' });
  }

  if (Date.now() > record.expiresAt) {
    return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
  }

  if (record.code !== otp.trim()) {
    return res.status(400).json({ success: false, message: 'Invalid OTP code. Please check and try again.' });
  }

  record.verified = true;
  otpStore.set(cleanPhone, record);
  otpStore.set(rawDigits, record);

  return res.json({
    success: true,
    message: 'Phone number verified successfully!'
  });
});

// 3. Step 1 & 2: Register DMC Partner into Firebase
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, country_code, contact_name, email, phone, website, currency, password, otp_verified } = req.body;

    // Strict Validations
    if (!validateName(name)) {
      return res.status(400).json({ success: false, message: 'Company/Contact Name must not contain numbers and must be at least 2 characters long.' });
    }

    if (contact_name && !validateName(contact_name)) {
      return res.status(400).json({ success: false, message: 'Contact Name must not contain numbers.' });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
    }

    if (!validateWebsite(website)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid website URL (e.g., https://yourcompany.com).' });
    }

    if (!phone || phone.trim().length < 6) {
      return res.status(400).json({ success: false, message: 'Valid phone number with country code is required.' });
    }

    const cleanPhone = phone.trim();
    const otpRecord = otpStore.get(cleanPhone);
    if (!otp_verified && (!otpRecord || !otpRecord.verified)) {
      return res.status(400).json({ success: false, message: 'Phone number must be verified via OTP before registering.' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const existing = await dbService.findPartnerByEmail(email);
    if (existing) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists. Please sign in.' });
    }

    const dmcId = 'DMC' + Date.now().toString().slice(-6);
    const formattedWebsite = website.startsWith('http') ? website : `https://${website}`;

    const newPartner = {
      dmc_id: dmcId,
      company_name: name.trim(),
      country_code: country_code || 'IN',
      contact_name: (contact_name || name).trim(),
      email: email.trim().toLowerCase(),
      phone: cleanPhone,
      website: formattedWebsite,
      currency: currency || 'USD',
      password: password,
      status: 'registered',
      kyc_level: 0,
      docs: {},
      packages: [],
      payouts: [],
      created_at: new Date().toISOString()
    };

    const saved = await dbService.savePartner(newPartner);

    return res.json({
      success: true,
      message: 'Account created successfully in Firebase!',
      dmc: saved
    });
  } catch (err) {
    console.error('[Register Error]', err);
    return res.status(500).json({ success: false, message: 'Registration failed: ' + err.message });
  }
});

// 4. Partner Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const partner = await dbService.findPartnerByEmail(email);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Account not found with this email' });
    }

    if (partner.password !== password) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    return res.json({
      success: true,
      message: 'Signed in successfully',
      dmc: partner
    });
  } catch (err) {
    console.error('[Login Error]', err);
    return res.status(500).json({ success: false, message: 'Login failed: ' + err.message });
  }
});

// Expose Firebase config parameters to frontend SDK
app.get('/api/config/firebase', (req, res) => {
  return res.json({
    projectId: process.env.FIREBASE_PROJECT_ID || 'plan-and-trip-poc',
    authDomain: `${process.env.FIREBASE_PROJECT_ID || 'plan-and-trip-poc'}.firebaseapp.com`,
    apiKey: process.env.FIREBASE_WEB_API_KEY || ''
  });
});

// 5. Step 3: Document Upload
app.post('/api/dmc/upload-docs', async (req, res) => {
  try {
    const { dmc_id, docs } = req.body;
    if (!dmc_id) {
      return res.status(400).json({ success: false, message: 'DMC ID is required' });
    }

    const partner = await dbService.getPartner(dmc_id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'DMC Partner not found' });
    }

    const updated = await dbService.updatePartnerStatus(dmc_id, 'in_review', docs);

    return res.json({
      success: true,
      message: 'Documents uploaded and submitted for backend review',
      dmc: updated
    });
  } catch (err) {
    console.error('[Upload Docs Error]', err);
    return res.status(500).json({ success: false, message: 'Document submission failed: ' + err.message });
  }
});

// 6. Get DMC Status (live polling)
app.get('/api/dmc/status/:id', async (req, res) => {
  try {
    const dmcId = req.params.id;
    const partner = await dbService.getPartner(dmcId);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'DMC Partner not found' });
    }

    return res.json({
      success: true,
      dmc_id: partner.dmc_id,
      status: partner.status,
      kyc_level: partner.kyc_level,
      docs: partner.docs || {},
      rejection_reason: partner.rejection_reason || ''
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 7. Admin Endpoint: Backend Document Approval Feature
app.post('/api/admin/approve-dmc', async (req, res) => {
  try {
    const { dmc_id, action, reason } = req.body;
    if (!dmc_id) {
      return res.status(400).json({ success: false, message: 'DMC ID is required' });
    }

    const partner = await dbService.getPartner(dmc_id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'DMC Partner not found' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const kycLevel = action === 'approve' ? 2 : 0;

    const updated = await dbService.savePartner({
      ...partner,
      status: newStatus,
      kyc_level: kycLevel,
      rejection_reason: action === 'reject' ? (reason || 'Documents incomplete or invalid') : '',
      approved_at: action === 'approve' ? new Date().toISOString() : null
    });

    console.log(`[Admin Backend Approval] DMC ${dmc_id} status updated to: ${newStatus}`);

    return res.json({
      success: true,
      message: `DMC status successfully updated to ${newStatus} in Firebase`,
      dmc: updated
    });
  } catch (err) {
    console.error('[Admin Approve Error]', err);
    return res.status(500).json({ success: false, message: 'Approval failed: ' + err.message });
  }
});

// 8. Admin Endpoint: List pending DMC approvals
app.get('/api/admin/pending-dmcs', async (req, res) => {
  try {
    const all = await dbService.getAllPartners();
    return res.json({
      success: true,
      partners: all
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Serve frontend portal HTML
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dmc_portal.html'));
});

app.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(`🚀 DMC Backend Server running on http://localhost:${PORT}`);
  console.log(`🔥 Firebase ID: plan-and-trip-poc | Firestore DB: planandtrippocnative`);
  console.log(`===========================================================`);
});
