// =============================================
// SchoolBank - Cloud Functions
// Deploy con: firebase deploy --only functions
// =============================================

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();

/**
 * Crea un nuovo utente (Admin o Teacher)
 * Callable da SuperAdmin o Admin
 */
exports.createUser = functions.https.onCall(async (data, context) => {
  // Verifica autenticazione
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Devi essere autenticato');
  }

  const callerUid = context.auth.uid;
  console.log('createUser called by:', callerUid);
  
// Ottieni il profilo del chiamante
  const callerDoc = await db.collection('users').doc(callerUid).get();
  
  if (!callerDoc.exists) {
    console.log('Caller profile not found, checking by email...');
    // Prova a cercare per email
    const email = context.auth.token.email;
    if (email) {
      const byEmail = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
      if (!byEmail.empty) {
        const profile = byEmail.docs[0].data();
        console.log('Found profile by email:', profile.role);
        
        // Verifica ruolo
        if (!['superadmin', 'admin'].includes(profile.role)) {
          throw new functions.https.HttpsError('permission-denied', 'Non hai i permessi per creare utenti');
        }
        
        // Continua con la creazione
        return await createUserInternal(data, profile, callerUid);
      }
    }
    throw new functions.https.HttpsError('permission-denied', 'Profilo utente non trovato');
  }
  
  const callerProfile = callerDoc.data();
  console.log('Caller role:', callerProfile.role);
  
  // Verifica ruolo
  if (!['superadmin', 'admin'].includes(callerProfile.role)) {
    throw new functions.https.HttpsError('permission-denied', 'Non hai i permessi per creare utenti');
  }
  
  return await createUserInternal(data, callerProfile, callerUid);
});

/**
 * Funzione interna per creare utente
 */
async function createUserInternal(data, callerProfile, callerUid) {
  const { email, password, name, role, schoolId, classes } = data;
  
  console.log('Creating user:', { email, name, role, schoolId });
  
  if (!email || !password || !name || !role) {
    throw new functions.https.HttpsError('invalid-argument', 'Dati mancanti: email, password, name, role sono richiesti');
  }
  
  if (password.length < 6) {
    throw new functions.https.HttpsError('invalid-argument', 'Password troppo corta (min 6 caratteri)');
  }
  
  // Controllo permessi per ruolo
  if (callerProfile.role === 'superadmin') {
    if (!['admin', 'teacher'].includes(role)) {
      throw new functions.https.HttpsError('invalid-argument', 'Ruolo non valido. Usa: admin o teacher');
    }
  } else if (callerProfile.role === 'admin') {
    if (role !== 'teacher') {
      throw new functions.https.HttpsError('permission-denied', 'Gli admin possono creare solo docenti');
    }
    if (schoolId !== callerProfile.schoolId) {
      throw new functions.https.HttpsError('permission-denied', 'Puoi creare utenti solo per la tua scuola');
    }
  }
  
  try {
    // Crea utente in Firebase Auth
    const userRecord = await auth.createUser({
      email: email.toLowerCase().trim(),
      password: password,
      displayName: name
    });
    
    console.log('Auth user created:', userRecord.uid);
    
    // Crea documento in Firestore
    await db.collection('users').doc(userRecord.uid).set({
      email: email.toLowerCase().trim(),
      name: name,
      role: role,
      schoolId: schoolId || null,
      classes: classes || [],
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: callerUid
    });
    
    console.log('Firestore document created');
    
    return {
      success: true,
      uid: userRecord.uid,
      message: `Utente ${name} creato con successo`
    };
    
  } catch (error) {
    console.error('Errore creazione utente:', error);
    
    if (error.code === 'auth/email-already-exists') {
      throw new functions.https.HttpsError('already-exists', 'Email già registrata');
    }
    if (error.code === 'auth/invalid-email') {
      throw new functions.https.HttpsError('invalid-argument', 'Email non valida');
    }
    if (error.code === 'auth/weak-password') {
      throw new functions.https.HttpsError('invalid-argument', 'Password troppo debole');
    }
    
    throw new functions.https.HttpsError('internal', error.message || 'Errore nella creazione utente');
  }
}

/**
 * Elimina un utente
 */
exports.deleteUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Devi essere autenticato');
  }

  const callerUid = context.auth.uid;
  const { userId } = data;
  
  if (!userId) {
    throw new functions.https.HttpsError('invalid-argument', 'ID utente mancante');
  }
  
  // Ottieni profilo chiamante
  let callerProfile = null;
  const callerDoc = await db.collection('users').doc(callerUid).get();
  
  if (callerDoc.exists) {
    callerProfile = callerDoc.data();
  } else {
    // Cerca per email
    const email = context.auth.token.email;
    if (email) {
      const byEmail = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
      if (!byEmail.empty) {
        callerProfile = byEmail.docs[0].data();
      }
    }
  }
  
  if (!callerProfile || !['superadmin', 'admin'].includes(callerProfile.role)) {
    throw new functions.https.HttpsError('permission-denied', 'Non hai i permessi');
  }
  
  // Ottieni profilo target
  const targetDoc = await db.collection('users').doc(userId).get();
  if (!targetDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Utente non trovato');
  }
  
  const targetProfile = targetDoc.data();
  
  // Controllo permessi
  if (callerProfile.role === 'admin') {
    if (targetProfile.role !== 'teacher' || targetProfile.schoolId !== callerProfile.schoolId) {
      throw new functions.https.HttpsError('permission-denied', 'Puoi eliminare solo docenti della tua scuola');
    }
  }
  
  if (targetProfile.role === 'superadmin') {
    throw new functions.https.HttpsError('permission-denied', 'Non puoi eliminare un superadmin');
  }
  
  try {
    // Elimina da Auth (se esiste)
    try {
      await auth.deleteUser(userId);
    } catch (e) {
      console.log('User not in Auth or already deleted:', e.message);
    }
    
    // Elimina da Firestore
    await db.collection('users').doc(userId).delete();
    
    return { success: true, message: 'Utente eliminato' };
    
  } catch (error) {
    console.error('Errore eliminazione:', error);
    throw new functions.https.HttpsError('internal', 'Errore nell\'eliminazione');
  }
});

/**
 * Aggiorna le classi di un docente
 */
exports.updateTeacherClasses = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Devi essere autenticato');
  }

  const { teacherId, classes } = data;
  
  if (!teacherId) {
    throw new functions.https.HttpsError('invalid-argument', 'ID docente mancante');
  }
  
  await db.collection('users').doc(teacherId).update({
    classes: classes || [],
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  return { success: true };
});
