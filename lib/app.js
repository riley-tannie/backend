const express = require('express');
const cors = require('cors');
const con = require('./db');
const argon2 = require('argon2');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
    res.json({ status: "Server is running" });
});

const resetRoomStatuses = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('en-CA'); // Local YYYY-MM-DD (no UTC issues)

    const resetSql = `
        UPDATE room_availability 
        SET status = 'free', student_id = NULL, booking_id = NULL 
        WHERE availability_date = ? AND status IN ('pending', 'reserved')
    `;
    
    con.query(resetSql, [tomorrowStr], (err) => {
        if (err) {
            console.error('Room status reset error:', err);
        } else {
            console.log('Room statuses reset for:', tomorrowStr);
        }
    });
};

const isTimeSlotValid = (timeSlot) => {
    const now = new Date();
    const times = timeSlot.split('-');
    if (times.length !== 2) return false;
    
    try {
        const [startTime, endTime] = times;
        const [endHour, endMinute] = endTime.split(':');
        
        const slotEnd = new Date();
        slotEnd.setHours(parseInt(endHour), parseInt(endMinute), 0, 0);
        
        return now < slotEnd;
    } catch (e) {
        return false;
    }
};

const scheduleDailyReset = () => {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    const delay = nextMidnight - now;

    setTimeout(() => {
        resetRoomStatuses();
        setInterval(resetRoomStatuses, 24 * 60 * 60 * 1000); // every 24 hours
    }, delay);
};

setTimeout(resetRoomStatuses, 5000);
scheduleDailyReset();

// Add input validation middleware
app.use((req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT') {
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({ error: 'Request body is required' });
        }
    }
    next();
});

// Add database connection check
const checkDatabaseConnection = () => {
    return new Promise((resolve, reject) => {
        con.query('SELECT 1', (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

// Health check endpoint with DB verification
app.get('/api/health', async (req, res) => {
    try {
        await checkDatabaseConnection();
        res.json({ 
            status: "Server is running",
            database: "Connected"
        });
    } catch (error) {
        res.status(500).json({ 
            status: "Server is running",
            database: "Disconnected",
            error: error.message
        });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    // Input validation
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    
    if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Invalid input format' });
    }
    
    const sql = "SELECT id, full_name, role, password FROM users WHERE email = ?";
    
    con.query(sql, [email], async (err, results) => {
        if (err) {
            console.error('Login database error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        
        if (results.length === 0) {
            return res.status(401).json({ error: 'Invalid login credentials' });
        }
        
        const user = results[0];
        
        try {
            const isPasswordValid = await argon2.verify(user.password, password);
            if (!isPasswordValid) {
                return res.status(401).json({ error: 'Invalid login credentials' });
            }
            
            let userType = 'student';
            if (email.endsWith('@mfu.th')) userType = 'staff';
            else if (email.endsWith('@mfu.ac.th')) userType = 'lecturer';
            
            res.json({
                uid: user.id,
                fullName: user.full_name,
                email: email,
                role: user.role,
                userType: userType
            });
        } catch (verifyError) {
            console.error('Password verification error:', verifyError);
            res.status(500).json({ error: 'Server error during login' });
        }
    });
});

app.post('/api/register', async (req, res) => {
    const { fullName, idNumber, email, password } = req.body;
    const role = 'student';

    try {
        const hashedPassword = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 2 ** 16,
            timeCost: 3,
            parallelism: 1
        });

        const sql = "INSERT INTO users (id, full_name, email, password, role) VALUES (?, ?, ?, ?, ?)";
        
        con.query(sql, [idNumber, fullName, email, hashedPassword, role], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(400).json({ error: 'User with this ID or email already exists' });
                }
                return res.status(500).json({ error: 'Registration failed' });
            }
            
            res.json({ success: true, message: 'Registration successful' });
        });
    } catch (hashError) {
        res.status(500).json({ error: 'Registration failed - password error' });
    }
});

app.get('/api/rooms', (req, res) => {
    const sql = "SELECT * FROM rooms";
    con.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

// Get ALL rooms including disabled ones (for staff management)
app.get('/api/rooms/all', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            r.*,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'free'), 0) as free_slots,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'pending'), 0) as pending_slots,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'reserved'), 0) as reserved_slots,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'disabled'), 0) as disabled_slots
        FROM rooms r
        WHERE r.name IS NOT NULL 
          AND r.name != '' 
          AND r.name != 'Unknown'
          AND r.category IS NOT NULL
        ORDER BY r.is_disabled, r.category, r.name
    `;
    
    con.query(sql, [today, today, today, today], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        
        const roomsWithStatus = results.map(room => ({
            id: room.id,
            name: room.name || `Room ${room.id.replace('room_', '')}`,
            category: room.category,
            location: room.location || 'Campus Building',
            description: room.description || `Available ${room.category.toLowerCase()} for bookings.`,
            image_url: room.image_url,
            is_disabled: room.is_disabled,
            free_slots: room.free_slots,
            pending_slots: room.pending_slots,
            reserved_slots: room.reserved_slots,
            disabled_slots: room.disabled_slots,
            can_disable: room.free_slots > 0 && room.pending_slots === 0 && room.reserved_slots === 0,
            can_enable: room.is_disabled === 1
        }));
        
        res.json(roomsWithStatus);
    });
});

app.get('/api/rooms/:roomId/time-slots', (req, res) => {
    const roomId = req.params.roomId;
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT ra.* 
        FROM room_availability ra 
        WHERE ra.room_id = ? AND ra.availability_date = ?
        ORDER BY ra.time_slot
    `;
    
    con.query(sql, [roomId, today], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        
        const validSlots = results.filter(slot => isTimeSlotValid(slot.time_slot));
        
        // If we have valid slots, return them
        if (validSlots.length > 0) {
            return res.json(validSlots);
        }
        
        // Initialize time slots if none exist
        const insertSql = `
            INSERT IGNORE INTO room_availability 
            (time_slot, status, room_id, availability_date) 
            VALUES (?, 'free', ?, ?)
        `;
        
        const timeSlots = ['08:00-10:00', '10:00-12:00', '13:00-15:00', '15:00-17:00'];
        const validTimeSlots = timeSlots.filter(slot => isTimeSlotValid(slot));
        
        if (validTimeSlots.length === 0) {
            return res.json([]); // No valid time slots for today
        }
        
        let insertedCount = 0;
        let insertionErrors = [];
        
        validTimeSlots.forEach(slot => {
            con.query(insertSql, [slot, roomId, today], (insertErr) => {
                if (insertErr) {
                    insertionErrors.push(insertErr);
                }
                insertedCount++;
                
                if (insertedCount === validTimeSlots.length) {
                    if (insertionErrors.length > 0) {
                        console.error('Insertion errors:', insertionErrors);
                        return res.status(500).json({ error: 'Failed to initialize time slots' });
                    }
                    
                    // Fetch the newly inserted slots
                    con.query(sql, [roomId, today], (fetchErr, fetchResults) => {
                        if (fetchErr) {
                            console.error('Fetch error:', fetchErr);
                            return res.status(500).json({ error: 'Server error' });
                        }
                        const validNewSlots = fetchResults.filter(s => isTimeSlotValid(s.time_slot));
                        res.json(validNewSlots);
                    });
                }
            });
        });
    });
});

app.post('/api/bookings', (req, res) => {
    const { studentId, roomId, timeSlot } = req.body;
    const today = new Date().toISOString().split('T')[0];
    
    // Input validation
    if (!studentId || !roomId || !timeSlot) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!isTimeSlotValid(timeSlot)) {
        return res.status(400).json({ error: 'This time slot has already passed and cannot be booked' });
    }
    
    // Start transaction-like process
    const checkSql = "SELECT * FROM bookings WHERE student_id = ? AND booking_date = ?";
    
    con.query(checkSql, [studentId, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error checking bookings' });
        if (results.length > 0) return res.status(400).json({ error: 'You can only book one slot per day' });
        
        const slotCheckSql = `
            SELECT * FROM room_availability 
            WHERE room_id = ? AND availability_date = ? AND time_slot = ? 
            AND status = 'free' AND (student_id IS NULL OR student_id = '')
        `;
        
        con.query(slotCheckSql, [roomId, today, timeSlot], (err, slotResults) => {
            if (err) return res.status(500).json({ error: 'Server error checking availability' });
            
            if (slotResults.length === 0) {
                const statusCheckSql = `
                    SELECT status, student_id FROM room_availability 
                    WHERE room_id = ? AND availability_date = ? AND time_slot = ?
                `;
                
                con.query(statusCheckSql, [roomId, today, timeSlot], (err, statusResults) => {
                    if (err || statusResults.length === 0) {
                        return res.status(400).json({ error: 'Time slot not available' });
                    }
                    
                    const slotStatus = statusResults[0];
                    let errorMessage = 'Time slot not available';
                    
                    if (slotStatus.status === 'pending') errorMessage = 'Time slot is already pending approval';
                    else if (slotStatus.status === 'reserved') errorMessage = 'Time slot is already reserved';
                    else if (slotStatus.student_id) errorMessage = 'Time slot is already booked by another student';
                    
                    res.status(400).json({ error: errorMessage });
                });
                return;
            }
            
            const bookingId = 'book_' + Date.now();
            const bookingSql = `
                INSERT INTO bookings (id, student_id, room_id, booking_date, time_slot, status) 
                VALUES (?, ?, ?, ?, ?, 'Pending')
            `;
            
            con.query(bookingSql, [bookingId, studentId, roomId, today, timeSlot], (err) => {
                if (err) return res.status(500).json({ error: 'Database error creating booking' });
                
                const updateSql = `
                    UPDATE room_availability 
                    SET status = 'pending', student_id = ?
                    WHERE room_id = ? AND availability_date = ? AND time_slot = ?
                `;
                
                con.query(updateSql, [studentId, roomId, today, timeSlot], (err) => {
                    if (err) {
                        const rollbackSql = "DELETE FROM bookings WHERE id = ?";
                        con.query(rollbackSql, [bookingId]);
                        return res.status(500).json({ error: 'Booking update failed' });
                    }
                    
                    res.json({ success: true, message: 'Booking created', bookingId: bookingId });
                });
            });
        });
    });
});

// Get all rooms with today's availability for students
app.get('/api/rooms/availability', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            r.*,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'free'), 0) as available_slots,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ?), 0) as total_slots
        FROM rooms r
        WHERE r.is_disabled = 0  -- Only show enabled rooms to students
          AND r.name IS NOT NULL 
          AND r.name != '' 
          AND r.name != 'Unknown'
          AND r.category IS NOT NULL
        ORDER BY r.category, r.name
    `;
    
    con.query(sql, [today, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        
        const roomsWithAvailability = results.map(room => ({
            id: room.id,
            name: room.name || `Room ${room.id.replace('room_', '')}`,
            category: room.category,
            location: room.location || 'Campus Building',
            description: room.description || `Available ${room.category.toLowerCase()} for bookings.`,
            image_url: room.image_url,
            available_slots: room.available_slots,
            total_slots: room.total_slots,
            is_available: room.available_slots > 0,
            is_disabled: room.is_disabled  // Include disabled status
        }));
        
        res.json(roomsWithAvailability);
    });
});

app.get('/api/bookings/student/:studentId/has-booked-today', (req, res) => {
    const studentId = req.params.studentId;
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT COUNT(*) as count 
        FROM bookings 
        WHERE student_id = ? AND booking_date = ?
    `;
    
    con.query(sql, [studentId, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json({ hasBooked: results[0].count > 0 });
    });
});

app.get('/api/bookings', (req, res) => {
    const sql = `
        SELECT 
            b.*, 
            r.name as room_name, 
            r.location, 
            u.full_name as student_name,
            u_lecturer.full_name as approved_by_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        LEFT JOIN users u_lecturer ON b.approved_by = u_lecturer.id
        ORDER BY b.booked_at DESC
    `;
    
    con.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

app.put('/api/bookings/:bookingId/status', (req, res) => {
    const bookingId = req.params.bookingId;
    const { status, approvedBy } = req.body;
    
    const getBookingSql = `
        SELECT student_id, room_id, booking_date, time_slot 
        FROM bookings 
        WHERE id = ?
    `;
    
    con.query(getBookingSql, [bookingId], (err, bookingResults) => {
        if (err) return res.status(500).json({ error: 'Failed to get booking details' });
        if (bookingResults.length === 0) return res.status(404).json({ error: 'Booking not found' });
        
        const booking = bookingResults[0];
        
        const updateBookingSql = `
            UPDATE bookings 
            SET status = ?, approved_by = ?, approved_at = NOW() 
            WHERE id = ?
        `;
        
        con.query(updateBookingSql, [status, approvedBy, bookingId], (err) => {
            if (err) return res.status(500).json({ error: 'Update failed' });
            
            const updateAvailabilitySql = `
                UPDATE room_availability 
                SET status = ? 
                WHERE room_id = ? AND availability_date = ? AND time_slot = ? AND student_id = ?
            `;
            
            let availabilityStatus = status.toLowerCase() === 'approved' ? 'reserved' : 'free';
            
            con.query(updateAvailabilitySql, [
                availabilityStatus, 
                booking.room_id, 
                booking.booking_date, 
                booking.time_slot,
                booking.student_id
            ], (err) => {
                if (err) console.error('Failed to update room availability:', err);
                res.json({ success: true, message: 'Booking status updated' });
            });
        });
    });
});

app.get('/api/dashboard/stats', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'free') as free_slots,
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'pending') as pending_slots,
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'reserved') as reserved_slots,
            (SELECT COUNT(*) FROM rooms WHERE is_disabled = 1) as disabled_rooms
    `;
    
    con.query(sql, [today, today, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results[0]);
    });
});

app.get('/api/bookings/student/:studentId', (req, res) => {
    const studentId = req.params.studentId;
    
    const sql = `
        SELECT 
            b.*, 
            r.name as room_name, 
            r.location, 
            r.image_url,
            u.full_name as student_name,
            u_lecturer.full_name as approved_by_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        LEFT JOIN users u_lecturer ON b.approved_by = u_lecturer.id
        WHERE b.student_id = ?
        ORDER BY b.booking_date DESC, b.time_slot DESC
    `;
    
    con.query(sql, [studentId], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

app.get('/api/bookings/student/:studentId/today', (req, res) => {
    const studentId = req.params.studentId;
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            b.*, 
            r.name as room_name, 
            r.location, 
            r.image_url,
            u.full_name as student_name,
            u_lecturer.full_name as approved_by_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        LEFT JOIN users u_lecturer ON b.approved_by = u_lecturer.id
        WHERE b.student_id = ? AND b.booking_date = ?
        ORDER BY 
            CASE 
                WHEN b.status = 'Pending' THEN 1
                WHEN b.status = 'Approved' THEN 2
                WHEN b.status = 'Rejected' THEN 3
                ELSE 4
            END,
            b.time_slot
    `;
    
    con.query(sql, [studentId, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

// -------------------- LECTURER -------------------------------

app.get('/api/bookings/pending', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            b.id,
            b.room_id,
            b.student_id,
            b.booking_date as date,
            b.time_slot,
            r.name as room_name,
            u.full_name as student_name,
            u_lecturer.full_name as approved_by_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        LEFT JOIN users u_lecturer ON b.approved_by = u_lecturer.id
        WHERE b.status = 'Pending' AND b.booking_date = ?
        ORDER BY b.booked_at ASC
    `;
    
    con.query(sql, [today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

app.get('/api/bookings/history/:lecturerId', (req, res) => {
    const lecturerId = req.params.lecturerId;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateString = thirtyDaysAgo.toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            b.id,
            b.room_id,
            b.student_id,
            b.booking_date,
            b.time_slot,
            b.status,
            b.approved_at,
            r.name as room_name,
            u.full_name as student_name,
            u_lecturer.full_name as approved_by_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        LEFT JOIN users u_lecturer ON b.approved_by = u_lecturer.id
        WHERE b.approved_by = ? AND b.approved_at >= ?
        ORDER BY b.approved_at DESC
    `;
    
    con.query(sql, [lecturerId, dateString], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

app.get('/api/rooms/lecturer', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            r.*,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'free'), 0) as free_slots,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'pending'), 0) as pending_slots,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'reserved'), 0) as reserved_slots,
            COALESCE((SELECT COUNT(*) FROM room_availability ra 
             WHERE ra.room_id = r.id AND ra.availability_date = ? AND ra.status = 'disabled'), 0) as disabled_slots
        FROM rooms r
        WHERE r.name IS NOT NULL 
          AND r.name != '' 
          AND r.name != 'Unknown'
          AND r.category IS NOT NULL
        ORDER BY r.is_disabled, r.category, r.name  -- Order by disabled status first
    `;
    
    con.query(sql, [today, today, today, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        
        const cleanedRooms = results.map(room => ({
            ...room,
            name: room.name || `Room ${room.id.replace('room_', '')}`,
            location: room.location || 'Campus Building',
            description: room.description || `Available ${room.category.toLowerCase()} for bookings.`
        }));
        
        res.json(cleanedRooms);
    });
});

app.get('/api/rooms/lecturer/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const today = new Date().toISOString().split('T')[0];
    
    const fetchSql = `
        SELECT 
            r.*,
            ra.time_slot,
            ra.status,
            ra.student_id,
            u.full_name as student_name
        FROM rooms r
        LEFT JOIN room_availability ra ON r.id = ra.room_id AND ra.availability_date = ?
        LEFT JOIN users u ON ra.student_id = u.id
        WHERE r.id = ?
        ORDER BY ra.time_slot
    `;
    
    con.query(fetchSql, [today, roomId], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        if (results.length === 0) return res.status(404).json({ error: 'Room not found' });
        
        const room = {
            id: results[0].id,
            name: results[0].name,
            category: results[0].category,
            location: results[0].location,
            description: results[0].description,
            image_url: results[0].image_url,
            is_disabled: results[0].is_disabled,
            time_slots: results
                .filter(row => row.time_slot)
                .map(row => ({
                    time_slot: row.time_slot,
                    status: row.status || 'free',
                    student_name: row.student_name
                }))
        };
        
        res.json(room);
    });
});

app.get('/api/dashboard/lecturer/:lecturerId', (req, res) => {
    const lecturerId = req.params.lecturerId;
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'free') as free_slots,
            (SELECT COUNT(*) FROM bookings WHERE status = 'Pending' AND booking_date = ?) as pending_requests,
            (SELECT COUNT(*) FROM bookings WHERE status = 'Approved' AND approved_by = ? AND booking_date = ?) as approved_bookings,
            (SELECT COUNT(*) FROM rooms WHERE is_disabled = 1) as disabled_rooms,
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'reserved') as reserved_slots
    `;
    
    con.query(sql, [today, today, lecturerId, today, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results[0]);
    });
});


// ------------------- STAFF -------------------------------
app.get('/api/dashboard/stats/today', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const sql = `
        SELECT 
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'free') as free_slots,
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'pending') as pending_slots,
            (SELECT COUNT(*) FROM room_availability WHERE availability_date = ? AND status = 'reserved') as reserved_slots,
            (SELECT COUNT(*) FROM rooms WHERE is_disabled = 1) as disabled_rooms,
            (SELECT COUNT(*) FROM bookings WHERE booking_date = ? AND status = 'Pending') as pending_requests,
            (SELECT COUNT(*) FROM bookings WHERE booking_date = ? AND status = 'Approved') as approved_today
    `;
    
    con.query(sql, [today, today, today, today, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results[0]);
    });
});

// Room management routes
app.post('/api/rooms', (req, res) => {
  const { name, category, location, description } = req.body;
  
  const roomId = 'room_' + Date.now();
  const sql = `
    INSERT INTO rooms (id, name, category, location, description, image_url) 
    VALUES (?, ?, ?, ?, ?, 'assets/images/default_room.jpg')
  `;
  
  con.query(sql, [roomId, name, category, location, description], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to create room' });
    
    // Create time slots for the new room for today AND tomorrow
    const timeSlots = ['08:00-10:00', '10:00-12:00', '13:00-15:00', '15:00-17:00'];
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    
    const dates = [today, tomorrowStr];
    let createdCount = 0;
    let totalSlots = dates.length * timeSlots.length;
    
    dates.forEach(date => {
      timeSlots.forEach(slot => {
        const slotSql = `
          INSERT INTO room_availability (room_id, availability_date, time_slot, status) 
          VALUES (?, ?, ?, 'free')
        `;
        
        con.query(slotSql, [roomId, date, slot], () => {
          createdCount++;
          if (createdCount === totalSlots) {
            res.json({ success: true, roomId: roomId });
          }
        });
      });
    });
  });
});

app.put('/api/rooms/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const { name, location, description } = req.body;
  
  const sql = `
    UPDATE rooms 
    SET name = ?, location = ?, description = ? 
    WHERE id = ?
  `;
  
  con.query(sql, [name, location, description, roomId], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to update room' });
    res.json({ success: true });
  });
});

app.patch('/api/rooms/:roomId/disable', (req, res) => {
  const roomId = req.params.roomId;
  const today = new Date().toISOString().split('T')[0];
  
  console.log(`Disabling room: ${roomId}`); // Debug log
  
  // Check if all slots are free
  const checkSql = `
    SELECT COUNT(*) as nonFreeCount 
    FROM room_availability 
    WHERE room_id = ? AND availability_date = ? AND status != 'free'
  `;
  
  con.query(checkSql, [roomId, today], (err, results) => {
    if (err) {
      console.error('Server error checking room status:', err);
      return res.status(500).json({ error: 'Server error' });
    }
    
    if (results[0].nonFreeCount > 0) {
      return res.status(400).json({ 
        error: 'Cannot disable room with booked or pending slots' 
      });
    }
    
    // Disable all free time slots
    const disableSlotsSql = `
      UPDATE room_availability 
      SET status = 'disabled' 
      WHERE room_id = ? AND availability_date = ? AND status = 'free'
    `;
    
    con.query(disableSlotsSql, [roomId, today], (err, result) => {
      if (err) {
        console.error('Failed to disable time slots:', err);
        return res.status(500).json({ error: 'Failed to disable time slots' });
      }
      
      console.log(`Disabled ${result.affectedRows} time slots`); // Debug log
      
      // Mark room as disabled
      const disableRoomSql = `UPDATE rooms SET is_disabled = 1 WHERE id = ?`;
      con.query(disableRoomSql, [roomId], (err, roomResult) => {
        if (err) {
          console.error('Failed to disable room:', err);
          return res.status(500).json({ error: 'Failed to disable room' });
        }
        
        console.log(`Room ${roomId} disabled successfully`); // Debug log
        
        res.json({ 
          success: true, 
          message: 'Room disabled successfully',
          affectedSlots: result.affectedRows
        });
      });
    });
  });
});

app.patch('/api/rooms/:roomId/enable', (req, res) => {
  const roomId = req.params.roomId;
  const today = new Date().toISOString().split('T')[0];
  
  console.log(`Enabling room: ${roomId}`); // Debug log
  
  // Enable all time slots (set disabled slots to free)
  const enableSlotsSql = `
    UPDATE room_availability 
    SET status = 'free' 
    WHERE room_id = ? AND availability_date = ? AND status = 'disabled'
  `;
  
  con.query(enableSlotsSql, [roomId, today], (err, result) => {
    if (err) {
      console.error('Failed to enable time slots:', err);
      return res.status(500).json({ error: 'Failed to enable time slots' });
    }
    
    console.log(`Enabled ${result.affectedRows} time slots`); // Debug log
    
    // Mark room as enabled
    const enableRoomSql = `UPDATE rooms SET is_disabled = 0 WHERE id = ?`;
    con.query(enableRoomSql, [roomId], (err, roomResult) => {
      if (err) {
        console.error('Failed to enable room:', err);
        return res.status(500).json({ error: 'Failed to enable room' });
      }
      
      console.log(`Room ${roomId} enabled successfully`); // Debug log
      
      res.json({ 
        success: true, 
        message: 'Room enabled successfully',
        affectedSlots: result.affectedRows
      });
    });
  });
});

app.patch('/api/rooms/:roomId/time-slots/:timeSlot/disable', (req, res) => {
  const { roomId, timeSlot } = req.params;
  const today = new Date().toISOString().split('T')[0];
  
  // Check if slot is free
  const checkSql = `
    SELECT status FROM room_availability 
    WHERE room_id = ? AND availability_date = ? AND time_slot = ?
  `;
  
  con.query(checkSql, [roomId, today, timeSlot], (err, results) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (results.length === 0) return res.status(404).json({ error: 'Time slot not found' });
    
    if (results[0].status !== 'free') {
      return res.status(400).json({ error: 'Can only disable free time slots' });
    }
    
    // Disable the time slot
    const disableSql = `
      UPDATE room_availability 
      SET status = 'disabled' 
      WHERE room_id = ? AND availability_date = ? AND time_slot = ?
    `;
    
    con.query(disableSql, [roomId, today, timeSlot], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to disable time slot' });
      
      // Check if all slots are now disabled
      const checkAllDisabledSql = `
        SELECT COUNT(*) as total, SUM(status = 'disabled') as disabled 
        FROM room_availability 
        WHERE room_id = ? AND availability_date = ?
      `;
      
      con.query(checkAllDisabledSql, [roomId, today], (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        
        if (results[0].total === results[0].disabled) {
          // All slots disabled, mark room as disabled
          const disableRoomSql = `UPDATE rooms SET is_disabled = 1 WHERE id = ?`;
          con.query(disableRoomSql, [roomId]);
        }
        
        res.json({ success: true });
      });
    });
  });
});

app.patch('/api/rooms/:roomId/time-slots/:timeSlot/enable', (req, res) => {
  const { roomId, timeSlot } = req.params;
  const today = new Date().toISOString().split('T')[0];
  
  // Enable the time slot
  const enableSql = `
    UPDATE room_availability 
    SET status = 'free' 
    WHERE room_id = ? AND availability_date = ? AND time_slot = ? AND status = 'disabled'
  `;
  
  con.query(enableSql, [roomId, today, timeSlot], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to enable time slot' });
    
    // Mark room as enabled since at least one slot is now free
    const enableRoomSql = `UPDATE rooms SET is_disabled = 0 WHERE id = ?`;
    con.query(enableRoomSql, [roomId]);
    
    res.json({ success: true });
  });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});