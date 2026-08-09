const { Firestore } = require('@google-cloud/firestore');
const admin = require('firebase-admin');

const PROJECT_ID = 'plan-and-trip-poc';
const DATABASE_ID = 'planandtrippocnative';
const COLLECTION_NAME = 'dmc_partners';

let db = null;
let isRealFirestore = false;

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: PROJECT_ID
    });
  }
  
  // Connect to custom database instance 'planandtrippocnative'
  db = new Firestore({
    projectId: PROJECT_ID,
    databaseId: DATABASE_ID
  });
  isRealFirestore = true;
  console.log(`[Firebase] Initialized Firestore for Project: ${PROJECT_ID}, Database: ${DATABASE_ID}`);
} catch (err) {
  console.warn(`[Firebase Warning] Could not connect directly to Firestore (${err.message}). Using local store fallback.`);
}

// In-Memory Storage Fallback for seamless offline development / testing if credentials are missing
const memoryStore = new Map();

const dbService = {
  getCollectionName: () => COLLECTION_NAME,
  
  async savePartner(partnerData) {
    const dmcId = partnerData.dmc_id || partnerData.id || `DMC_${Date.now()}`;
    const docData = {
      ...partnerData,
      dmc_id: dmcId,
      updated_at: new Date().toISOString(),
      created_at: partnerData.created_at || new Date().toISOString()
    };

    if (isRealFirestore && db) {
      try {
        await db.collection(COLLECTION_NAME).doc(dmcId).set(docData, { merge: true });
        console.log(`[Firebase Firestore] Saved partner ${dmcId} in database ${DATABASE_ID}`);
      } catch (err) {
        console.error(`[Firebase Firestore Error] ${err.message}. Saving to memory store.`);
        memoryStore.set(dmcId, docData);
      }
    } else {
      memoryStore.set(dmcId, docData);
    }
    return docData;
  },

  async getPartner(dmcId) {
    if (isRealFirestore && db) {
      try {
        const snap = await db.collection(COLLECTION_NAME).doc(dmcId).get();
        if (snap.exists) {
          return snap.data();
        }
      } catch (err) {
        console.error(`[Firebase Firestore Error] ${err.message}`);
      }
    }
    return memoryStore.get(dmcId) || null;
  },

  async findPartnerByEmail(email) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (isRealFirestore && db) {
      try {
        const snap = await db.collection(COLLECTION_NAME).where('email', '==', cleanEmail).limit(1).get();
        if (!snap.empty) {
          return snap.docs[0].data();
        }
      } catch (err) {
        console.error(`[Firebase Firestore Error] ${err.message}`);
      }
    }
    for (const partner of memoryStore.values()) {
      if (String(partner.email || '').trim().toLowerCase() === cleanEmail) {
        return partner;
      }
    }
    return null;
  },

  async updatePartnerStatus(dmcId, status, docs = null, rejectionReason = '') {
    const existing = await this.getPartner(dmcId);
    if (!existing) {
      throw new Error(`Partner ${dmcId} not found`);
    }

    const updated = {
      ...existing,
      status: status,
      updated_at: new Date().toISOString()
    };

    if (docs) {
      updated.docs = { ...(existing.docs || {}), ...docs };
    }
    if (rejectionReason) {
      updated.rejection_reason = rejectionReason;
    }

    return await this.savePartner(updated);
  },

  async getAllPartners() {
    if (isRealFirestore && db) {
      try {
        const snap = await db.collection(COLLECTION_NAME).get();
        const list = [];
        snap.forEach(doc => list.push(doc.data()));
        return list;
      } catch (err) {
        console.error(`[Firebase Firestore Error] ${err.message}`);
      }
    }
    return Array.from(memoryStore.values());
  }
};

module.exports = dbService;
