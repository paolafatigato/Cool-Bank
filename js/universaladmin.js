/* =============================================
   SchoolBank - Universal Admin Module
   Handles auth, multi-school context & impersonation
   ============================================= */

const Auth = {
  currentUser: null,
  userProfile: null,
  impersonating: null,
  
  // Initialize auth listener
  init() {
    return new Promise((resolve) => {
      firebase.auth().onAuthStateChanged(async (user) => {
        this.currentUser = user;
        if (user) {
          await this.loadUserProfile(user.uid);
        } else {
          this.userProfile = null;
          this.impersonating = null;
        }
        resolve(user);
      });
    });
  },
  
  // Load user profile from Firestore
  async loadUserProfile(uid) {
    try {
      // Prima prova a caricare il profilo con l'UID
      let doc = await db.collection('users').doc(uid).get();
      
      if (doc.exists) {
        this.userProfile = { uid, ...doc.data() };
        
        // Load impersonation state from localStorage
        const savedImpersonation = localStorage.getItem('schoolbank_impersonation');
        if (savedImpersonation && this.userProfile.role === 'superadmin') {
          this.impersonating = JSON.parse(savedImpersonation);
        }
        return;
      }
      
      // Se non esiste, cerca un documento con la stessa email (creato da admin/superadmin)
      const email = this.currentUser.email.toLowerCase().trim();
      const pendingQuery = await db.collection('users')
        .where('email', '==', email)
        .limit(1)
        .get();
      
      if (!pendingQuery.empty) {
        const pendingDoc = pendingQuery.docs[0];
        const pendingData = pendingDoc.data();
        
        console.log('Found pending user document, linking to auth...');
        
        // Crea il documento con l'UID corretto
        await db.collection('users').doc(uid).set({
          email: pendingData.email,
          name: pendingData.name,
          role: pendingData.role,
          schoolId: pendingData.schoolId || null,
          classes: pendingData.classes || [],
          status: 'active',
          createdAt: pendingData.createdAt || firebase.firestore.FieldValue.serverTimestamp(),
          linkedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        // Elimina il documento pending/temporaneo
        await pendingDoc.ref.delete();
        
        // Ricarica il profilo
        doc = await db.collection('users').doc(uid).get();
        this.userProfile = { uid, ...doc.data() };
        
        // Load impersonation state
        const savedImpersonation = localStorage.getItem('schoolbank_impersonation');
        if (savedImpersonation && this.userProfile.role === 'superadmin') {
          this.impersonating = JSON.parse(savedImpersonation);
        }
        return;
      }
      
      // Nessun profilo trovato
      console.warn('No user profile found for:', email);
      this.userProfile = null;
      
    } catch (error) {
      console.error('Error loading user profile:', error);
    }
  },
  
  // Get effective school ID (handles impersonation)
  getEffectiveSchoolId() {
    if (this.impersonating) {
      return this.impersonating.schoolId;
    }
    return this.userProfile?.schoolId || null;
  },
  
  // Get effective role (for impersonation context)
  getEffectiveRole() {
    if (this.impersonating) {
      return this.impersonating.role || 'admin';
    }
    return this.userProfile?.role || null;
  },
  
  // Check if currently impersonating
  isImpersonating() {
    return !!this.impersonating;
  },
  
  // Start impersonation (superadmin only)
  async startImpersonation(schoolId, schoolName) {
    if (this.userProfile?.role !== 'superadmin') {
      throw new Error('Solo i superadmin possono impersonare');
    }
    
    this.impersonating = {
      schoolId,
      schoolName,
      role: 'admin',
      startedAt: new Date().toISOString()
    };
    
    localStorage.setItem('schoolbank_impersonation', JSON.stringify(this.impersonating));
    return this.impersonating;
  },
  
  // Stop impersonation
  stopImpersonation() {
    this.impersonating = null;
    localStorage.removeItem('schoolbank_impersonation');
  },
  
  // Login with email/password
  async login(email, password) {
    const credential = await firebase.auth().signInWithEmailAndPassword(email, password);
    await this.loadUserProfile(credential.user.uid);
    return this.userProfile;
  },
  
  // Logout
  async logout() {
    this.stopImpersonation();
    await firebase.auth().signOut();
    this.currentUser = null;
    this.userProfile = null;
  },
  
  // Check permissions
  can(action, resource) {
    const role = this.getEffectiveRole();
    
    const permissions = {
      superadmin: ['*'],
      admin: [
        'manage:teachers', 'manage:students', 'manage:classes',
        'manage:rewards', 'manage:subjects', 'view:transactions',
        'view:reports', 'manage:settings'
      ],
      teacher: [
        'give:rewards', 'view:students', 'view:classes', 'view:transactions'
      ],
      student: ['view:self']
    };
    
    const rolePerms = permissions[role] || [];
    if (rolePerms.includes('*')) return true;
    
    return rolePerms.includes(`${action}:${resource}`);
  },
  
  // Require auth - redirect to login if not authenticated
  requireAuth(allowedRoles = []) {
    if (!this.currentUser || !this.userProfile) {
      window.location.href = 'index.html';
      return false;
    }
    
    if (allowedRoles.length > 0) {
      const effectiveRole = this.getEffectiveRole();
      if (!allowedRoles.includes(effectiveRole) && effectiveRole !== 'superadmin') {
        Toast.error('Non hai i permessi per accedere a questa pagina');
        window.location.href = 'index.html';
        return false;
      }
    }
    
    return true;
  },
  
  // Check if user can act as admin (is admin or superadmin)
  canActAsAdmin() {
    const role = this.getEffectiveRole();
    return role === 'admin' || role === 'superadmin';
  }
};

/* =============================================
   Database Helper - Multi-school aware queries
   ============================================= */

const DB = {
  // Get reference to school collection
  school(collectionName) {
    const schoolId = Auth.getEffectiveSchoolId();
    if (!schoolId) throw new Error('No school context');
    return db.collection('schools').doc(schoolId).collection(collectionName);
  },
  
  // Get school document reference
  schoolDoc() {
    const schoolId = Auth.getEffectiveSchoolId();
    if (!schoolId) throw new Error('No school context');
    return db.collection('schools').doc(schoolId);
  },
  
  // Get school data
  async getSchoolData() {
    const doc = await this.schoolDoc().get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  
  // Students
  async getStudents(classId = null) {
    let query = this.school('students');
    if (classId) {
      query = query.where('classId', '==', classId);
    }
    const snapshot = await query.orderBy('name').get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  async getStudent(studentId) {
    const doc = await this.school('students').doc(studentId).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  
  async createStudent(data) {
    const ref = await this.school('students').add({
      ...data,
      balance: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  },
  
  async updateStudent(studentId, data) {
    await this.school('students').doc(studentId).update({
      ...data,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  },
  
  async deleteStudent(studentId) {
    await this.school('students').doc(studentId).delete();
  },
  
  // Classes
  async getClasses() {
    const snapshot = await this.school('classes').orderBy('name').get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  async createClass(data) {
    const ref = await this.school('classes').add({
      ...data,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  },
  
  async updateClass(classId, data) {
    await this.school('classes').doc(classId).update(data);
  },
  
  async deleteClass(classId) {
    await this.school('classes').doc(classId).delete();
  },
  
  // Teachers
  async getTeachers() {
    const schoolId = Auth.getEffectiveSchoolId();
    const snapshot = await db.collection('users')
      .where('schoolId', '==', schoolId)
      .where('role', '==', 'teacher')
      .get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  // Rewards
  async getRewards() {
    const snapshot = await this.school('rewards').orderBy('cost').get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  async getQuickRewards() {
    const snapshot = await this.school('quickRewards').orderBy('amount', 'desc').get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  async createReward(data) {
    const ref = await this.school('rewards').add({
      ...data,
      active: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  },
  
  async createQuickReward(data) {
    const ref = await this.school('quickRewards').add({
      ...data,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  },
  
  // Transactions
  async createTransaction(data) {
    const ref = await this.school('transactions').add({
      ...data,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      teacherId: Auth.currentUser?.uid,
      teacherName: Auth.userProfile?.name || 'Sistema'
    });
    return ref.id;
  },
  
  async getTransactions(filters = {}, limit = 50) {
    let query = this.school('transactions');
    
    if (filters.studentId) {
      query = query.where('studentId', '==', filters.studentId);
      query = query.orderBy('timestamp', 'desc').limit(limit);
      const snapshot = await query.get();
      return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    if (filters.classId) {
      query = query.where('classId', '==', filters.classId);
      query = query.orderBy('timestamp', 'desc').limit(limit);
      const snapshot = await query.get();
      return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    if (filters.teacherId) {
      // For teacherId, fetch without ordering to avoid index requirement
      // Then sort in JavaScript
      query = query.where('teacherId', '==', filters.teacherId);
      const snapshot = await query.get();
      const transactions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort by timestamp descending in JavaScript
      transactions.sort((a, b) => {
        const timeA = a.timestamp?.toMillis?.() || 0;
        const timeB = b.timestamp?.toMillis?.() || 0;
        return timeB - timeA;
      });
      return transactions.slice(0, limit);
    }
    
    query = query.orderBy('timestamp', 'desc').limit(limit);
    const snapshot = await query.get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  // Give reward to student
  async giveReward(studentId, amount, reason, icon = '⭐', subjectId = null) {
    const batch = db.batch();
    const schoolId = Auth.getEffectiveSchoolId();
    
    // Update student balance
    const studentRef = db.collection('schools').doc(schoolId)
      .collection('students').doc(studentId);
    
    const studentDoc = await studentRef.get();
    if (!studentDoc.exists) throw new Error('Studente non trovato');
    
    const newBalance = (studentDoc.data().balance || 0) + amount;
    batch.update(studentRef, { 
      balance: newBalance,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    // Create transaction
    const txRef = db.collection('schools').doc(schoolId)
      .collection('transactions').doc();
    
    batch.set(txRef, {
      studentId,
      studentName: studentDoc.data().name,
      classId: studentDoc.data().classId,
      amount,
      reason,
      icon,
      subjectId,
      type: amount >= 0 ? 'reward' : 'penalty',
      teacherId: Auth.currentUser?.uid,
      teacherName: Auth.userProfile?.name || 'Sistema',
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    await batch.commit();
    return { newBalance, transactionId: txRef.id };
  },
  
  // Give reward to entire class
  async giveClassReward(classId, amount, reason, icon = '🎉') {
    const students = await this.getStudents(classId);
    const results = [];
    
    for (const student of students) {
      const result = await this.giveReward(student.id, amount, reason, icon);
      results.push({ studentId: student.id, ...result });
    }
    
    return results;
  },
  
  // Subjects
  async getSubjects() {
    const snapshot = await this.school('subjects').orderBy('name').get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  async createSubject(data) {
    const ref = await this.school('subjects').add({
      ...data,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  },
  
  // Reward Requests
  async getRewardRequests(status = 'pending') {
    const snapshot = await this.school('rewardRequests')
      .where('status', '==', status)
      .orderBy('requestedAt', 'desc')
      .get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  async approveRewardRequest(requestId) {
    const requestDoc = await this.school('rewardRequests').doc(requestId).get();
    if (!requestDoc.exists) throw new Error('Richiesta non trovata');
    
    const request = requestDoc.data();
    const rewardDoc = await this.school('rewards').doc(request.rewardId).get();
    if (!rewardDoc.exists) throw new Error('Premio non trovato');
    
    const reward = rewardDoc.data();
    
    // Deduct cost from student
    await this.giveReward(
      request.studentId,
      -reward.cost,
      `Riscatto: ${reward.name}`,
      reward.icon || '🎁'
    );
    
    // Update request status
    await this.school('rewardRequests').doc(requestId).update({
      status: 'approved',
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      approvedBy: Auth.currentUser?.uid
    });
  },
  
  async rejectRewardRequest(requestId, reason = '') {
    await this.school('rewardRequests').doc(requestId).update({
      status: 'rejected',
      rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
      rejectedBy: Auth.currentUser?.uid,
      rejectionReason: reason
    });
  },

  // Delete transaction
  async deleteTransaction(transactionId) {
    const txRef = this.school('transactions').doc(transactionId);
    const txDoc = await txRef.get();
    
    if (!txDoc.exists) {
      throw new Error('Transazione non trovata');
    }
    
    const tx = txDoc.data();
    
    // Reverse the balance change
    const studentRef = this.school('students').doc(tx.studentId);
    await studentRef.update({
      balance: firebase.firestore.FieldValue.increment(-tx.amount)
    });
    
    // Delete transaction
    await txRef.delete();
  },

  // Update transaction
  async updateTransaction(transactionId, updates) {
    const txRef = this.school('transactions').doc(transactionId);
    await txRef.update({
      ...updates,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  },

  // Adjust student balance
  async adjustStudentBalance(studentId, amount) {
    const studentRef = this.school('students').doc(studentId);
    await studentRef.update({
      balance: firebase.firestore.FieldValue.increment(amount)
    });
  }
};

/* =============================================
   SuperAdmin specific functions
   ============================================= */

const SuperAdmin = {
  // Get all schools
  async getSchools() {
    const snapshot = await db.collection('schools').orderBy('config.name').get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  
  // Create new school
  async createSchool(data) {
    const ref = await db.collection('schools').add({
      config: {
        name: data.name,
        currencySymbol: data.currencySymbol || '$',
        currencyName: data.currencyName || 'Dollari',
        showLeaderboard: data.showLeaderboard !== false,
        maxDebt: data.maxDebt || 0
      },
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'active'
    });
    return ref.id;
  },
  
  // Get school statistics
  async getSchoolStats(schoolId) {
    const studentsSnap = await db.collection('schools').doc(schoolId)
      .collection('students').get();
    
    const teachersSnap = await db.collection('users')
      .where('schoolId', '==', schoolId)
      .where('role', '==', 'teacher')
      .get();
    
    const classesSnap = await db.collection('schools').doc(schoolId)
      .collection('classes').get();
    
    return {
      students: studentsSnap.size,
      teachers: teachersSnap.size,
      classes: classesSnap.size
    };
  }
};

/* =============================================
   User Management (via Cloud Functions)
   ============================================= */

const UserManager = {
  _functions: null,
  
  init() {
    if (typeof firebase !== 'undefined' && firebase.functions) {
      this._functions = firebase.functions();
      console.log('UserManager initialized (Cloud Functions mode)');
    } else {
      console.warn('Firebase Functions not available, falling back to Firestore mode');
    }
  },
  
  /**
   * Crea un nuovo utente tramite Cloud Function
   */
  async createUser(email, password, name, role, schoolId, classes = []) {
    // Prova prima con Cloud Functions
    if (this._functions) {
      try {
        const createUserFn = this._functions.httpsCallable('createUser');
        const result = await createUserFn({ email, password, name, role, schoolId, classes });
        return result.data;
      } catch (error) {
        // Se Cloud Functions non sono deployate o c'è un errore di auth, usa fallback
        if (error.code === 'functions/not-found' || error.code === 'functions/unauthenticated' || error.message.includes('not found') || error.message.includes('401')) {
          console.warn('Cloud Functions not available or auth error, using Firestore fallback');
          return this._createUserFallback(email, password, name, role, schoolId, classes);
        }
        throw error;
      }
    }
    
    // Fallback: crea solo documento Firestore
    return this._createUserFallback(email, password, name, role, schoolId, classes);
  },
  
  /**
   * Fallback: crea documento in Firestore e tenta di creare utente in Auth
   */
  async _createUserFallback(email, password, name, role, schoolId, classes) {
    const existing = await db.collection('users').where('email', '==', email.toLowerCase().trim()).limit(1).get();
    if (!existing.empty) {
      throw new Error('Email già registrata');
    }
    
    let authUid = null;
    let status = 'pending';
    
    // Tenta di creare l'utente in Firebase Auth
    try {
      const userRecord = await firebase.auth().createUserWithEmailAndPassword(email.toLowerCase().trim(), password);
      authUid = userRecord.user.uid;
      status = 'active';
      console.log('User created in Firebase Auth:', authUid);
    } catch (authError) {
      console.warn('Could not create user in Firebase Auth, will create as pending:', authError.message);
      // Se falisce, continua con lo stato 'pending'
    }
    
    // Se siamo riusciti a creare l'utente in Auth, usa quello UID
    if (authUid) {
      try {
        console.log('Writing to Firestore with UID:', authUid, { email, name, role, schoolId, classes, status });
        await db.collection('users').doc(authUid).set({
          email: email.toLowerCase().trim(),
          name,
          role,
          schoolId: schoolId || null,
          classes: classes || [],
          status: 'active',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log('Successfully wrote user document to Firestore');
        return { success: true, uid: authUid, fallback: true, authCreated: true };
      } catch (firestoreError) {
        console.error('Firestore write failed:', firestoreError);
        
        // Se è un errore di permessi, store in localStorage come fallback
        if (firestoreError.message.includes('permission')) {
          console.warn('Permission denied, storing user data in localStorage for manual sync');
          const pendingUser = {
            uid: authUid,
            email: email.toLowerCase().trim(),
            name,
            role,
            schoolId: schoolId || null,
            classes: classes || [],
            status: 'active',
            createdAt: new Date().toISOString()
          };
          
          // Store in localStorage
          let pendingUsers = JSON.parse(localStorage.getItem('schoolbank_pending_users') || '[]');
          pendingUsers.push(pendingUser);
          localStorage.setItem('schoolbank_pending_users', JSON.stringify(pendingUsers));
          
          console.log('User stored in localStorage:', pendingUser);
          return { 
            success: true, 
            uid: authUid, 
            fallback: true, 
            authCreated: true,
            storedLocally: true,
            message: 'Utente creato in Auth ma salvato localmente. Contatta l\'amministratore per sincronizzare.'
          };
        }
        
        throw new Error(`Firestore error: ${firestoreError.message}`);
      }
    }
    
    // Fallback: crea solo documento in Firestore
    try {
      console.log('Creating pending user in Firestore:', { email, name, role, schoolId, classes });
      const userRef = await db.collection('users').add({
        email: email.toLowerCase().trim(),
        name,
        role,
        schoolId: schoolId || null,
        classes: classes || [],
        status: 'pending',
        tempPassword: password,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      console.log('Successfully created pending user:', userRef.id);
      return { success: true, uid: userRef.id, fallback: true, authCreated: false };
    } catch (firestoreError) {
      console.error('Failed to create pending user:', firestoreError);
      throw new Error(`Firestore error: ${firestoreError.message}`);
    }
  },
  
  /**
   * Elimina utente
   */
  async deleteUser(userId) {
    if (this._functions) {
      try {
        const deleteUserFn = this._functions.httpsCallable('deleteUser');
        const result = await deleteUserFn({ userId });
        return result.data;
      } catch (error) {
        // Usa fallback se Cloud Functions non è disponibile o c'è errore di auth
        if (error.code === 'functions/not-found' || error.code === 'functions/unauthenticated' || error.message.includes('401')) {
          await db.collection('users').doc(userId).delete();
          return { success: true };
        }
        throw error;
      }
    }
    await db.collection('users').doc(userId).delete();
    return { success: true };
  },
  
  /**
   * Aggiorna classi docente
   */
  async updateTeacherClasses(teacherId, classes) {
    await db.collection('users').doc(teacherId).update({
      classes: classes || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  },
  
  /**
   * Ottieni utenti di una scuola
   */
  async getSchoolUsers(schoolId, role = null) {
    let query = db.collection('users').where('schoolId', '==', schoolId);
    if (role) query = query.where('role', '==', role);
    const snapshot = await query.get();
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  }
};

/* =============================================
   Utility functions
   ============================================= */

const Format = {
  currency(amount, symbol = '$') {
    return `${symbol}${Math.abs(amount).toLocaleString()}`;
  },
  
  relativeTime(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'adesso';
    if (minutes < 60) return `${minutes}m fa`;
    if (hours < 24) return `${hours}h fa`;
    if (days < 7) return `${days}g fa`;
    
    return date.toLocaleDateString('it-IT');
  },
  
  dateTime(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString('it-IT');
  }
};

/* =============================================
   Toast notifications
   ============================================= */

const Toast = {
  container: null,
  
  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  
  show(message, type = 'info', duration = 3000) {
    this.init();
    
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <div class="toast-content">
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;
    
    this.container.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
  
  success(message) { this.show(message, 'success'); },
  error(message) { this.show(message, 'error', 5000); },
  warning(message) { this.show(message, 'warning'); },
  info(message) { this.show(message, 'info'); }
};

/* =============================================
   Modal helper
   ============================================= */

const Modal = {
  show(modalId) {
    const backdrop = document.getElementById(`${modalId}Backdrop`);
    const modal = document.getElementById(modalId);
    if (backdrop) backdrop.classList.add('active');
    if (modal) modal.classList.add('active');
  },
  
  hide(modalId) {
    const backdrop = document.getElementById(`${modalId}Backdrop`);
    const modal = document.getElementById(modalId);
    if (backdrop) backdrop.classList.remove('active');
    if (modal) modal.classList.remove('active');
  },
  
  // Quick confirm dialog
  async confirm(message, title = 'Conferma') {
    return new Promise((resolve) => {
      const id = 'confirmModal_' + Date.now();
      const html = `
        <div id="${id}Backdrop" class="modal-backdrop active"></div>
        <div id="${id}" class="modal active">
          <div class="modal-header">
            <h3 class="modal-title">${title}</h3>
          </div>
          <div class="modal-body">
            <p>${message}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Modal._confirmResolve(false, '${id}')">Annulla</button>
            <button class="btn btn-primary" onclick="Modal._confirmResolve(true, '${id}')">Conferma</button>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML('beforeend', html);
      this._confirmResolver = resolve;
    });
  },
  
  _confirmResolve(value, id) {
    document.getElementById(`${id}Backdrop`)?.remove();
    document.getElementById(id)?.remove();
    if (this._confirmResolver) {
      this._confirmResolver(value);
      this._confirmResolver = null;
    }
  }
};

/* =============================================
   UI Helpers
   ============================================= */

const UI = {
  // Render impersonation banner if active
  renderImpersonationBanner() {
    const existing = document.getElementById('impersonationBanner');
    if (existing) existing.remove();
    
    if (!Auth.isImpersonating()) return;
    
    const banner = document.createElement('div');
    banner.id = 'impersonationBanner';
    banner.className = 'impersonation-banner';
    banner.innerHTML = `
      <div class="impersonation-info">
        <span>👤</span>
        <span>Stai visualizzando come: <strong>${Auth.impersonating.schoolName}</strong></span>
      </div>
      <button class="impersonation-exit" onclick="UI.exitImpersonation()">
        Esci dalla visualizzazione
      </button>
    `;
    
    document.body.insertBefore(banner, document.body.firstChild);
    
    // Adjust main content margin
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.style.marginTop = '48px';
    }
  },
  
  async exitImpersonation() {
    Auth.stopImpersonation();
    window.location.reload();
  },
  
  // Toggle sidebar on mobile
  toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    sidebar?.classList.toggle('open');
  },
  
  // Set active nav item
  setActiveNav(navId) {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });
    const activeItem = document.querySelector(`[data-nav="${navId}"]`);
    if (activeItem) activeItem.classList.add('active');
  },
  
  // Generate initials for avatar
  getInitials(name) {
    if (!name) return '?';
    return name.split(' ')
      .map(part => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  },
  
  // Loading state
  showLoading(containerId) {
    const container = document.getElementById(containerId);
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="spinner spinner-lg"></div>
          <p class="mt-4">Caricamento...</p>
        </div>
      `;
    }
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  Toast.init();
});