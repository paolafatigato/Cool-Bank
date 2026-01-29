/* =============================================
   SchoolBank - Main Application Script
   ============================================= */

// Note: Firebase configuration is loaded from firebase-config.js
// Copy firebase-config.example.js to firebase-config.js and add your credentials

// Initialize Firebase
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();
const auth = firebase.auth();

// Enable persistence for offline support
db.enablePersistence().catch(err => {
  console.warn('Persistence failed:', err.code);
});

/* =============================================
   Page Navigation & Routing
   ============================================= */

const Router = {
  pages: {
    superadmin: 'superadmin.html',
    admin: 'admin.html',
    teacher: 'teacher.html',
    student: 'student.html'
  },
  
  // Redirect to appropriate page based on role
  redirectByRole(role) {
    const page = this.pages[role];
    if (page && window.location.pathname.indexOf(page) === -1) {
      window.location.href = page;
    }
  },
  
  // Check if on correct page
  isCorrectPage(role) {
    const page = this.pages[role];
    return window.location.pathname.indexOf(page) !== -1;
  }
};

/* =============================================
   Login Page Functions
   ============================================= */

const LoginPage = {
  async init() {
    // Check if already logged in
    const user = await Auth.init();
    if (user && Auth.userProfile) {
      Router.redirectByRole(Auth.userProfile.role);
    }
  },
  
  async handleLogin(e) {
    e.preventDefault();
    
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    if (!email || !password) {
      Toast.error('Inserisci email e password');
      return;
    }
    
    try {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner spinner-sm"></span> Accesso...';
      
      const profile = await Auth.login(email, password);
      Toast.success(`Benvenuto, ${profile.name}!`);
      
      // Redirect based on role
      setTimeout(() => {
        Router.redirectByRole(profile.role);
      }, 500);
      
    } catch (error) {
      console.error('Login error:', error);
      let message = 'Errore durante l\'accesso';
      
      switch (error.code) {
        case 'auth/user-not-found':
        case 'auth/wrong-password':
          message = 'Email o password non corretti';
          break;
        case 'auth/too-many-requests':
          message = 'Troppi tentativi. Riprova tra qualche minuto';
          break;
        case 'auth/invalid-email':
          message = 'Email non valida';
          break;
      }
      
      Toast.error(message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '🚀 Accedi';
    }
  },
  
  async handleLogout() {
    try {
      await Auth.logout();
      window.location.href = 'index.html';
    } catch (error) {
      Toast.error('Errore durante il logout');
    }
  }
};

/* =============================================
   Common Dashboard Functions
   ============================================= */

const Dashboard = {
  async init() {
    // Wait for auth
    await Auth.init();
    
    if (!Auth.currentUser || !Auth.userProfile) {
      window.location.href = 'index.html';
      return;
    }
    
    // Render user info in sidebar
    this.renderUserInfo();
    
    // Render impersonation banner if needed
    UI.renderImpersonationBanner();
    
    // Load school info
    await this.loadSchoolInfo();
  },
  
  renderUserInfo() {
    const userNameEl = document.getElementById('userName');
    const dashboardUserNameEl = document.getElementById('dashboardUserName');
    const userRoleEl = document.getElementById('userRole');
    const userAvatarEl = document.getElementById('userAvatar');
    
    if (userNameEl) userNameEl.textContent = Auth.userProfile.name;
    if (dashboardUserNameEl) dashboardUserNameEl.textContent = Auth.userProfile.name;
    if (userRoleEl) {
      const roles = {
        superadmin: 'Super Admin',
        admin: 'Amministratore',
        teacher: 'Docente'
      };
      userRoleEl.textContent = Auth.isImpersonating() 
        ? `${roles['admin']} (impersonando)` 
        : roles[Auth.userProfile.role];
    }
    if (userAvatarEl) {
      userAvatarEl.textContent = UI.getInitials(Auth.userProfile.name);
    }
  },
  
  async loadSchoolInfo() {
    const schoolId = Auth.getEffectiveSchoolId();
    if (!schoolId) return;
    
    try {
      const schoolData = await DB.getSchoolData();
      if (schoolData) {
        const schoolNameEl = document.getElementById('schoolName');
        if (schoolNameEl) {
          schoolNameEl.textContent = schoolData.config?.name || 'SchoolBank';
        }
        
        // Store currency settings
        window.currencySymbol = schoolData.config?.currencySymbol || '$';
        window.currencyName = schoolData.config?.currencyName || 'Dollari';
      }
    } catch (error) {
      console.error('Error loading school info:', error);
    }
  },
  
  // Common stats loader
  async loadStats() {
    try {
      const [students, classes, teachers] = await Promise.all([
        DB.getStudents(),
        DB.getClasses(),
        DB.getTeachers()
      ]);
      
      return {
        studentCount: students.length,
        classCount: classes.length,
        teacherCount: teachers.length,
        totalBalance: students.reduce((sum, s) => sum + (s.balance || 0), 0)
      };
    } catch (error) {
      console.error('Error loading stats:', error);
      return { studentCount: 0, classCount: 0, teacherCount: 0, totalBalance: 0 };
    }
  }
};

/* =============================================
   NFC Helper for Student Cards
   ============================================= */

const NFC = {
  // Generate a random NFC tag ID
  generateTag() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let tag = '';
    for (let i = 0; i < 8; i++) {
      tag += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return tag;
  },
  
  // Generate student URL
  getStudentUrl(studentId) {
    const baseUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
    return `${baseUrl}/student.html?id=${studentId}`;
  },
  
  // Generate NFC URL
  getNfcUrl(nfcTag) {
    const baseUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
    return `${baseUrl}/student.html?nfc=${nfcTag}`;
  }
};

/* =============================================
   Search & Filter Helpers
   ============================================= */

const Search = {
  // Debounce function for search inputs
  debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },
  
  // Filter array by search term
  filter(items, searchTerm, fields) {
    if (!searchTerm) return items;
    
    const term = searchTerm.toLowerCase();
    return items.filter(item => {
      return fields.some(field => {
        const value = item[field];
        return value && value.toString().toLowerCase().includes(term);
      });
    });
  }
};

/* =============================================
   Export functions for CSV
   ============================================= */

const Export = {
  // Convert data to CSV
  toCSV(data, columns) {
    const header = columns.map(c => c.label).join(',');
    const rows = data.map(item => {
      return columns.map(c => {
        let value = item[c.key] || '';
        // Escape quotes and wrap in quotes if contains comma
        if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
          value = `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',');
    });
    
    return [header, ...rows].join('\n');
  },
  
  // Download CSV file
  download(data, columns, filename) {
    const csv = this.toCSV(data, columns);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    
    URL.revokeObjectURL(url);
  }
};

/* =============================================
   Form Validation Helpers
   ============================================= */

const Validate = {
  email(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  },
  
  required(value) {
    return value !== null && value !== undefined && value.toString().trim() !== '';
  },
  
  minLength(value, min) {
    return value && value.length >= min;
  },
  
  maxLength(value, max) {
    return !value || value.length <= max;
  },
  
  number(value) {
    return !isNaN(parseFloat(value)) && isFinite(value);
  },
  
  positive(value) {
    return this.number(value) && parseFloat(value) > 0;
  }
};

/* =============================================
   Keyboard Shortcuts
   ============================================= */

const Shortcuts = {
  handlers: {},
  
  init() {
    document.addEventListener('keydown', (e) => {
      // Don't trigger shortcuts when typing in inputs
      if (e.target.matches('input, textarea, select')) return;
      
      const key = [
        e.ctrlKey ? 'ctrl' : '',
        e.shiftKey ? 'shift' : '',
        e.altKey ? 'alt' : '',
        e.key.toLowerCase()
      ].filter(Boolean).join('+');
      
      if (this.handlers[key]) {
        e.preventDefault();
        this.handlers[key]();
      }
    });
  },
  
  register(key, handler) {
    this.handlers[key.toLowerCase()] = handler;
  }
};

// Initialize shortcuts
Shortcuts.init();

// Common shortcuts
Shortcuts.register('escape', () => {
  // Close any open modal
  document.querySelectorAll('.modal.active').forEach(modal => {
    Modal.hide(modal.id);
  });
});

/* =============================================
   Console welcome message
   ============================================= */

console.log(`
%c 🏦 SchoolBank %c v1.0.0 
%c Sistema di economia di classe per scuole
`, 
'background: #7B4B8C; color: white; padding: 10px 20px; font-size: 20px; font-weight: bold;',
'background: #F5A623; color: black; padding: 10px 20px; font-size: 20px;',
'color: #6B5B7A; font-size: 12px;'
);