const mysql = require('mysql2');

// Create connection
const con = mysql.createConnection({
    host: 'localhost',
    user: 'root', 
    password: '', // Leave empty if no password, or add your MySQL password
    database: 'room_reservation'
});

// Connect to database
con.connect((err) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        return;
    }
    console.log('✅ Connected to MySQL database');
});

module.exports = con;