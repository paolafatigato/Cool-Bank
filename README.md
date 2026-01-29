# SchoolBank 🏦

A school banking system with multi-role management (Superadmin, Admin, Teacher, Student) built with Firebase.

## Features

- 👥 Multi-role authentication system
- 🏫 Multi-school management
- 💰 Virtual banking system for students
- 📊 Transaction tracking and reporting
- 🔐 Secure Firebase authentication
- 📱 Responsive design

## Setup Instructions

### Prerequisites

- Firebase account
- Web browser
- Node.js (for Firebase Functions)

### Installation

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd cool-try
   ```

2. **Configure Firebase:**
   - Create a new Firebase project at [Firebase Console](https://console.firebase.google.com/)
   - Enable Authentication (Email/Password)
   - Create a Firestore database
   - Copy `js/firebase-config.example.js` to `js/firebase-config.js`
   - Replace the placeholder values with your Firebase project credentials

3. **Set up Firestore Security Rules:**
   - Use the rules in `firestore-rules-fixed.txt`
   - Apply them in your Firebase Console under Firestore Database > Rules

4. **Deploy Firebase Functions (optional):**
   ```bash
   cd functions
   npm install
   firebase deploy --only functions
   ```

5. **Open the application:**
   - Open `index.html` in your web browser
   - Or deploy to Firebase Hosting:
     ```bash
     firebase deploy --only hosting
     ```

## File Structure

```
├── index.html              # Login page
├── superadmin.html         # Superadmin dashboard
├── admin.html              # Admin dashboard
├── teacher.html            # Teacher dashboard
├── student.html            # Student dashboard
├── css/
│   ├── style.css          # Main styles
│   └── variables.css      # CSS variables
├── js/
│   ├── script.js          # Main application logic
│   ├── universaladmin.js  # Auth and admin utilities
│   └── firebase-config.js # Firebase configuration (not tracked)
└── functions/
    └── index.js           # Firebase Cloud Functions
```

## User Roles

- **Superadmin**: Manage multiple schools and admins
- **Admin**: Manage teachers and students for their school
- **Teacher**: Manage class transactions
- **Student**: View balance and transaction history

## Security Notes

⚠️ **Important**: Never commit `js/firebase-config.js` to version control. It contains sensitive API keys.

- Configure Firebase Security Rules properly
- Enable Firebase App Check for production
- Use environment variables for sensitive data
- Review the Firestore rules before deploying

## License

MIT License

## Support

For issues or questions, please open an issue on GitHub.
