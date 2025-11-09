const express = require('express');
const cors = require('cors');
const con = require('./db');
const argon2 = require('argon2');

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: "Server is running" });
});

// Login 
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    const sql = "SELECT id, full_name, role, password FROM users WHERE email = ?";
    
    con.query(sql, [email], async (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        if (results.length === 0) return res.status(401).json({ error: 'Invalid login' });
        
        const user = results[0];
        
        try {
            // Verify the password with Argon2
            const isPasswordValid = await argon2.verify(user.password, password);
            
            if (!isPasswordValid) {
                return res.status(401).json({ error: 'Invalid login' });
            }
            
            // Determine user type based on email domain for routing
            let userType = 'student'; // default
            if (email.endsWith('@mfu.th')) {
                userType = 'staff';
            } else if (email.endsWith('@mfu.ac.th')) {
                userType = 'lecturer';
            }
            
            res.json({
                uid: user.id,
                fullName: user.full_name,
                email: email,
                role: user.role,
                userType: userType // Add this field for frontend routing
            });
        } catch (verifyError) {
            console.error('Password verification error:', verifyError);
            return res.status(500).json({ error: 'Server error during login' });
        }
    });
});

// Register (Updated for Argon2)
app.post('/api/register', async (req, res) => {
    const { fullName, idNumber, email, password } = req.body;

    // Set default role to 'student' - removed email domain checking
    const role = 'student';

    try {
        // Hash the password with Argon2
        const hashedPassword = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 2 ** 16, // 64MB
            timeCost: 3,
            parallelism: 1
        });

        const sql = "INSERT INTO users (id, full_name, email, password, role) VALUES (?, ?, ?, ?, ?)";
        
        con.query(sql, [idNumber, fullName, email, hashedPassword, role], (err, result) => {
            if (err) {
                console.error('Registration database error:', err);
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(400).json({ error: 'User with this ID or email already exists' });
                }
                return res.status(500).json({ error: 'Registration failed' });
            }
            
            res.json({
                success: true,
                message: 'Registration successful'
            });
        });
    } catch (hashError) {
        console.error('Password hashing error:', hashError);
        return res.status(500).json({ error: 'Registration failed - password error' });
    }
});

// Get all rooms
app.get('/api/rooms', (req, res) => {
    const sql = "SELECT * FROM rooms";
    con.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

app.get('/api/rooms/:roomId/time-slots', (req, res) => {
    const roomId = req.params.roomId;
    const today = new Date().toISOString().split('T')[0]; // This should give you 2025-11-07
    
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
        
        // If slots exist for today, return them
        if (results.length > 0) {
            return res.json(results);
        }
        
        const defaultSlots = [
            ['08:00-10:00', 'free', roomId, today, null, null],
            ['10:00-12:00', 'free', roomId, today, null, null],
            ['13:00-15:00', 'free', roomId, today, null, null],
            ['15:00-17:00', 'free', roomId, today, null, null],
        ];
        
        const insertSql = `
            INSERT IGNORE INTO room_availability 
            (time_slot, status, room_id, availability_date, student_id, booking_id) 
            VALUES ?
        `;
        
        con.query(insertSql, [defaultSlots], (insertErr, insertResult) => {
            if (insertErr) {
                console.error('Error inserting default slots:', insertErr);
                return res.status(500).json({ error: 'Failed to create time slots' });
            }
            
            console.log('Default slots inserted for today, fetching them...');
            
            // Fetch the newly inserted slots
            con.query(sql, [roomId, today], (fetchErr, fetchResults) => {
                if (fetchErr) {
                    console.error('Error fetching new slots:', fetchErr);
                    return res.status(500).json({ error: 'Server error' });
                }
                res.json(fetchResults);
            });
        });
    });
});

app.post('/api/bookings', (req, res) => {
    const { studentId, roomId, timeSlot } = req.body;
    const today = new Date().toISOString().split('T')[0];
    
    console.log('Booking request:', { studentId, roomId, timeSlot, today });
    
    // First check if student already booked today
    const checkSql = "SELECT * FROM bookings WHERE student_id = ? AND booking_date = ?";
    
    con.query(checkSql, [studentId, today], (err, results) => {
        if (err) {
            console.error('Error checking existing bookings:', err);
            return res.status(500).json({ error: 'Server error checking bookings' });
        }
        
        if (results.length > 0) {
            return res.status(400).json({ error: 'You can only book one slot per day' });
        }
        
            const slotCheckSql = `
                SELECT * FROM room_availability 
                WHERE room_id = ? AND availability_date = ? AND time_slot = ? 
                AND status = 'free' AND (student_id IS NULL OR student_id = '')
            `;
        
        con.query(slotCheckSql, [roomId, today, timeSlot], (err, slotResults) => {
            if (err) {
                console.error('Error checking time slot availability:', err);
                return res.status(500).json({ error: 'Server error checking availability' });
            }
            
            console.log('Slot check results:', slotResults);
            
            if (slotResults.length === 0) {
                // Get current slot status for better error message
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
                    
                    if (slotStatus.status === 'pending') {
                        errorMessage = 'Time slot is already pending approval';
                    } else if (slotStatus.status === 'reserved') {
                        errorMessage = 'Time slot is already reserved';
                    } else if (slotStatus.student_id && slotStatus.student_id !== 'NULL') {
                        errorMessage = 'Time slot is already booked by another student';
                    }
                    
                    return res.status(400).json({ error: errorMessage });
                });
                return;
            }
            
            // Create booking first
            const bookingId = 'book_' + Date.now();
            const bookingSql = `
                INSERT INTO bookings (id, student_id, room_id, booking_date, time_slot, status) 
                VALUES (?, ?, ?, ?, ?, 'Pending')
            `;
            
            console.log('Creating booking with ID:', bookingId);
            
            con.query(bookingSql, [bookingId, studentId, roomId, today, timeSlot], (err, result) => {
                if (err) {
                    console.error('Error creating booking:', err);
                    return res.status(500).json({ error: 'Database error creating booking: ' + err.message });
                }
                
                console.log('Booking created successfully, updating room availability...');
                
                // Update room availability - set to pending and link student
                const updateSql = `
                    UPDATE room_availability 
                    SET status = 'pending', student_id = ?
                    WHERE room_id = ? AND availability_date = ? AND time_slot = ?
                `;
                
                con.query(updateSql, [studentId, roomId, today, timeSlot], (err, updateResult) => {
                    if (err) {
                        console.error('Failed to update room availability:', err);
                        
                        // Rollback the booking if availability update fails
                        const rollbackSql = "DELETE FROM bookings WHERE id = ?";
                        con.query(rollbackSql, [bookingId], (rollbackErr) => {
                            if (rollbackErr) {
                                console.error('Failed to rollback booking:', rollbackErr);
                            }
                        });
                        
                        return res.status(500).json({ error: 'Booking update failed: ' + err.message });
                    }
                    
                    console.log('Room availability updated to pending successfully');
                    res.json({ success: true, message: 'Booking created', bookingId: bookingId });
                });
            });
        });
    });
});

// Check if student has booked today
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

// Get all bookings (for staff/lecturer)
app.get('/api/bookings', (req, res) => {
    const sql = `
        SELECT b.*, r.name as room_name, r.location, u.full_name as student_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        ORDER BY b.booked_at DESC
    `;
    
    con.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        res.json(results);
    });
});

// Update booking status (for lecturer approval) - FIXED VERSION
app.put('/api/bookings/:bookingId/status', (req, res) => {
    const bookingId = req.params.bookingId;
    const { status, approvedBy } = req.body;
    
    // First get the booking details to update room_availability
    const getBookingSql = `
        SELECT student_id, room_id, booking_date, time_slot 
        FROM bookings 
        WHERE id = ?
    `;
    
    con.query(getBookingSql, [bookingId], (err, bookingResults) => {
        if (err) return res.status(500).json({ error: 'Failed to get booking details' });
        
        if (bookingResults.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        const booking = bookingResults[0];
        
        // Update booking status
        const updateBookingSql = `
            UPDATE bookings 
            SET status = ?, approved_by = ?, approved_at = NOW() 
            WHERE id = ?
        `;
        
    con.query(updateBookingSql, [status, approvedBy, bookingId], (err, result) => {
        if (err) return res.status(500).json({ error: 'Update failed' });
        
        // Update room availability status - FIXED to not use booking_id
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
        ], (err, updateResult) => {
            if (err) {
                console.error('Failed to update room availability:', err);
                // Still return success since booking was updated
            }
            
            res.json({ success: true, message: 'Booking status updated' });
        });
    });
    });
});

// Get dashboard stats
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

// ========== NEW ENDPOINTS ADDED ==========

// Get student bookings (for booking history)
app.get('/api/bookings/student/:studentId', (req, res) => {
    const studentId = req.params.studentId;
    
    const sql = `
        SELECT 
            b.*, 
            r.name as room_name, 
            r.location, 
            r.image_url,
            u.full_name as student_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        WHERE b.student_id = ?
        ORDER BY b.booking_date DESC, b.time_slot DESC
    `;
    
    con.query(sql, [studentId], (err, results) => {
        if (err) {
            console.error('Error fetching student bookings:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(results);
    });
});

// Get student today bookings (for request status) - FIXED VERSION
app.get('/api/bookings/student/:studentId/today', (req, res) => {
    const studentId = req.params.studentId;
    const today = new Date().toISOString().split('T')[0];
    
    console.log(`Fetching today's bookings for student: ${studentId}, date: ${today}`);
    
    const sql = `
        SELECT 
            b.*, 
            r.name as room_name, 
            r.location, 
            r.image_url,
            u.full_name as student_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
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
        if (err) {
            console.error('Error fetching today bookings:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        
        console.log(`Found ${results.length} bookings for today`);
        res.json(results);
    });
});
///  ------- LECTURER LECUTRER LECTURER -------------
//LECTUERERS!!!
// Get pending requests for lecturer
// Get TODAY'S pending requests for lecturer
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
            u.full_name as student_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        WHERE b.status = 'Pending' AND b.booking_date = ?
        ORDER BY b.booked_at ASC
    `;
    
    con.query(sql, [today], (err, results) => {
        if (err) {
            console.error('Error fetching pending requests:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(results);
    });
});

// Get approval history for lecturer (LAST 30 DAYS)
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
            u.full_name as student_name
        FROM bookings b 
        JOIN rooms r ON b.room_id = r.id 
        JOIN users u ON b.student_id = u.id
        WHERE b.approved_by = ? AND b.approved_at >= ?
        ORDER BY b.approved_at DESC
    `;
    
    con.query(sql, [lecturerId, dateString], (err, results) => {
        if (err) {
            console.error('Error fetching approval history:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(results);
    });
});

// Get TODAY'S rooms with availability status for lecturer
// Get TODAY'S rooms with availability status for lecturer - FIXED VERSION
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
        WHERE r.is_disabled = 0 
          AND r.name IS NOT NULL 
          AND r.name != '' 
          AND r.name != 'Unknown'
          AND r.category IS NOT NULL
        ORDER BY r.category, r.name
    `;
    
    con.query(sql, [today, today, today, today], (err, results) => {
        if (err) {
            console.error('Error fetching rooms for lecturer:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        
        // Simple cleanup - just ensure no null values
        const cleanedRooms = results.map(room => ({
            ...room,
            name: room.name || `Room ${room.id.replace('room_', '')}`,
            location: room.location || 'Campus Building',
            description: room.description || `Available ${room.category.toLowerCase()} for bookings.`
        }));
        
        console.log(`Returning ${cleanedRooms.length} valid rooms for lecturer`);
        res.json(cleanedRooms);
    });
});
// Get TODAY'S room details with time slots for lecturer
app.get('/api/rooms/lecturer/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const today = new Date().toISOString().split('T')[0];
    
    // First, ensure time slots exist for today
    const ensureSlotsSql = `
        INSERT IGNORE INTO room_availability 
        (time_slot, status, room_id, availability_date, student_id, booking_id) 
        SELECT 
            ts.time_slot, 
            'free', 
            ?, 
            ?, 
            NULL, 
            NULL 
        FROM (
            SELECT '08:00-10:00' as time_slot
            UNION SELECT '10:00-12:00'
            UNION SELECT '13:00-15:00'
            UNION SELECT '15:00-17:00'
        ) ts
        WHERE NOT EXISTS (
            SELECT 1 FROM room_availability 
            WHERE room_id = ? AND availability_date = ?
        )
    `;
    
    con.query(ensureSlotsSql, [roomId, today, roomId, today], (ensureErr) => {
        if (ensureErr) {
            console.error('Error ensuring time slots:', ensureErr);
        }
        
        // Now fetch the room with time slots
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
            if (err) {
                console.error('Error fetching room details:', err);
                return res.status(500).json({ error: 'Server error' });
            }
            
            if (results.length === 0) {
                return res.status(404).json({ error: 'Room not found' });
            }
            
            // Format the response
            const room = {
                id: results[0].id,
                name: results[0].name,
                category: results[0].category,
                location: results[0].location,
                description: results[0].description,
                image_url: results[0].image_url,
                is_disabled: results[0].is_disabled,
                time_slots: results
                    .filter(row => row.time_slot) // Only include rows with time slots
                    .map(row => ({
                        time_slot: row.time_slot,
                        status: row.status || 'free',
                        student_name: row.student_name
                    }))
            };
            
            res.json(room);
        });
    });
});

// Get TODAY'S lecturer dashboard stats
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
        if (err) {
            console.error('Error fetching lecturer dashboard stats:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(results[0]);
    });
});

// NEW: Get comprehensive today's stats for dashboard
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});