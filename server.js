//server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initDB } = require('./db');
const path = require('path'); // <-- import 'path' for safety

// Initialize database
initDB();

const app = express();
app.use(cors());
app.use(express.json());

// 1) Serve static files in the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// 2) Optionally, create a route to serve privacy.html at /privacy
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/account-deletion', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account-deletion.html'));
});

// --------------------------------------------------------------------
// POST /users
// Creates a user row with (name, email, clerk_id, username, display_name).
// We require username/displayName (front-end is always sending them).
// --------------------------------------------------------------------
app.post('/users', async (req, res) => {
  try {
    const { name, email, clerkId, username, displayName } = req.body;

    // Must have all 5 fields
    if (!name || !email || !clerkId || !username || !displayName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Insert user into "users" table
    const query = `
        INSERT INTO users (name, email, clerk_id, username, display_name)
        VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
    `;
    const values = [name, email, clerkId, username, displayName];
    const result = await pool.query(query, values);

    return res.status(201).json({ data: result.rows });
  } catch (error) {
    console.error('Error creating user:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// PATCH /users/:clerkId
// Allows updating advanced fields like username, display_name, bio, is_pro
// (If you don't want them to change username, remove that field here.)
// --------------------------------------------------------------------
app.patch('/users/:clerkId', async (req, res) => {
  try {
    const { clerkId } = req.params;
    if (!clerkId) {
      return res.status(400).json({ error: 'Missing clerkId param.' });
    }

    const { username, display_name, bio, is_pro } = req.body;
    let setClauses = [];
    let values = [];
    let idx = 1;

    if (username !== undefined) {
      setClauses.push(`username = $${idx++}`);
      values.push(username);
    }
    if (display_name !== undefined) {
      setClauses.push(`display_name = $${idx++}`);
      values.push(display_name);
    }
    if (bio !== undefined) {
      setClauses.push(`bio = $${idx++}`);
      values.push(bio);
    }
    if (is_pro !== undefined) {
      setClauses.push(`is_pro = $${idx++}`);
      values.push(is_pro);
    }

    if (setClauses.length === 0) {
      return res
        .status(400)
        .json({ error: 'No valid fields provided to update.' });
    }

    const setClause = setClauses.join(', ');
    const updateQuery = `
        UPDATE users
        SET ${setClause}
        WHERE clerk_id = $${idx}
            RETURNING *;
    `;
    values.push(clerkId);

    let result;
    try {
      result = await pool.query(updateQuery, values);
    } catch (error) {
      // If there's a unique constraint on username or email, handle it
      if (error.code === '23505') {
        return res
          .status(409)
          .json({ error: 'That username or email is already taken.' });
      }
      throw error;
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('Error updating user:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// GET /users/clerkId/:clerkId
// Fetch user details by clerk_id
// --------------------------------------------------------------------
app.get('/users/clerkId/:clerkId', async (req, res) => {
  try {
    const { clerkId } = req.params;
    if (!clerkId) {
      return res.status(400).json({ error: 'Missing clerkId param.' });
    }

    const query = `
        SELECT *
        FROM users
        WHERE clerk_id = $1
            LIMIT 1;
    `;
    const { rows } = await pool.query(query, [clerkId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ data: rows[0] });
  } catch (error) {
    console.error('Error fetching user by clerkId:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// GET /users/username/:username
// Return user + array of that user's public_characters
// Also check if current viewer has liked this user => liked_by_current_user
// We pass ?viewerClerkId=someId in the query params
// --------------------------------------------------------------------
app.get('/users/username/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { viewerClerkId } = req.query; // who is viewing

    if (!username) {
      return res.status(400).json({ error: 'Missing username param.' });
    }

    // We'll pass $2 as the viewer's clerkId if present, otherwise null
    const sql = `
        SELECT
            u.id AS user_id,
            u.clerk_id,
            u.username,
            u.display_name,
            u.bio,
            u.user_likes_count,
            u.is_pro,

            -- If user_likes_users row is found, then the viewer is considered to have liked
            CASE WHEN ul.user_clerk_id IS NOT NULL THEN true ELSE false END AS liked_by_current_user,

            json_agg(
                    json_build_object(
                            'id', c.id,
                            'clerk_id', c.clerk_id,
                            'name', c.name,
                            'subtitle', c.subtitle,
                            'description', c.description,
                            'conversation_style', c.conversation_style,
                            'model_name', c.model_name,
                            'likes_count', c.likes_count,
                            'downloads_count', c.downloads_count
                    )
            ) FILTER (WHERE c.id IS NOT NULL) AS characters

        FROM users u
                 LEFT JOIN public_characters c
                           ON c.clerk_id = u.clerk_id
            -- Join user_likes_users to see if the viewer has liked them
                 LEFT JOIN user_likes_users ul
                           ON ul.liked_user_id = u.id
                               AND ul.user_clerk_id = $2

        WHERE u.username = $1
        GROUP BY u.id, ul.user_clerk_id;
    `;

    const { rows } = await pool.query(sql, [username, viewerClerkId || null]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userRow = rows[0];

    // If userRow.characters is [null], fix that to []
    if (
      userRow.characters &&
      userRow.characters.length === 1 &&
      userRow.characters[0] === null
    ) {
      userRow.characters = [];
    }

    res.json({ data: userRow });
  } catch (error) {
    console.error('Error fetching user by username:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// POST /users/:username/toggle-like
// Toggle a "like" on the user with that username
// (NOT for liking characters; for user-likes.)
// --------------------------------------------------------------------
app.post('/users/:username/toggle-like', async (req, res) => {
  try {
    const { username } = req.params;
    const { userClerkId } = req.body; // who is liking/unliking

    if (!username || !userClerkId) {
      return res
        .status(400)
        .json({ error: 'Missing username or userClerkId in body.' });
    }

    // 1) Find the user being liked
    const findUserQuery = `
        SELECT id, user_likes_count
        FROM users
        WHERE username = $1
            LIMIT 1;
    `;
    const { rows: userRows } = await pool.query(findUserQuery, [username]);
    if (userRows.length === 0) {
      return res
        .status(404)
        .json({ error: 'No user found with that username.' });
    }
    const likedUserId = userRows[0].id;

    // 2) Check if the (liker) already liked them
    const findLikeQuery = `
        SELECT *
        FROM user_likes_users
        WHERE liked_user_id = $1 AND user_clerk_id = $2
            LIMIT 1;
    `;
    const { rows: likeRows } = await pool.query(findLikeQuery, [
      likedUserId,
      userClerkId,
    ]);

    let liked;
    let updatedUserRow;
    if (likeRows.length === 0) {
      // Not liked -> Insert row
      const insertLike = `
          INSERT INTO user_likes_users (liked_user_id, user_clerk_id)
          VALUES ($1, $2);
      `;
      await pool.query(insertLike, [likedUserId, userClerkId]);

      // Increment user_likes_count
      const updateLikes = `
          UPDATE users
          SET user_likes_count = user_likes_count + 1
          WHERE id = $1
              RETURNING *;
      `;
      const { rows } = await pool.query(updateLikes, [likedUserId]);
      updatedUserRow = rows[0];
      liked = true;
    } else {
      // Already liked -> remove
      const removeLike = `
          DELETE FROM user_likes_users
          WHERE liked_user_id = $1 AND user_clerk_id = $2;
      `;
      await pool.query(removeLike, [likedUserId, userClerkId]);

      // Decrement
      const updateLikes = `
          UPDATE users
          SET user_likes_count = GREATEST(user_likes_count - 1, 0)
          WHERE id = $1
              RETURNING *;
      `;
      const { rows } = await pool.query(updateLikes, [likedUserId]);
      updatedUserRow = rows[0];
      liked = false;
    }

    res.json({ data: updatedUserRow, liked });
  } catch (error) {
    console.error('Error toggling like on user:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// GET /publicCharacters?sortBy=likes or downloads
// Returns top 20 public characters, including the user's username and pro status
// --------------------------------------------------------------------
app.get('/publicCharacters', async (req, res) => {
  try {
    const sortBy = req.query.sortBy;
    let orderColumn = 'likes_count'; // default is sorting by likes
    if (sortBy === 'downloads') {
      orderColumn = 'downloads_count';
    }

    const query = `
        SELECT pc.*, u.username, u.is_pro
        FROM public_characters pc
                 LEFT JOIN users u ON pc.clerk_id = u.clerk_id
        ORDER BY ${orderColumn} DESC
            LIMIT 20;
    `;
    const { rows } = await pool.query(query);
    return res.json({ data: rows });
  } catch (error) {
    console.error('Error fetching public characters:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// POST /publicCharacters
// Create or update a character
// --------------------------------------------------------------------
app.post('/publicCharacters', async (req, res) => {
  try {
    const {
      id, // If present, update
      clerkId,
      name,
      subtitle = '',
      description,
      conversationStyle,
      modelName,
    } = req.body;

    // Basic validation
    if (!clerkId || !name || !description || !conversationStyle || !modelName) {
      return res.status(400).json({ error: 'Missing fields.' });
    }

    if (id) {
      // Update existing
      const updateQuery = `
          UPDATE public_characters
          SET
              name = $1,
              subtitle = $2,
              description = $3,
              conversation_style = $4,
              model_name = $5,
              updated_at = NOW()
          WHERE id = $6
              RETURNING *;
      `;
      const values = [
        name,
        subtitle,
        description,
        conversationStyle,
        modelName,
        id,
      ];
      const { rows } = await pool.query(updateQuery, values);
      return res.status(200).json({ data: rows });
    } else {
      // Create new
      const insertQuery = `
          INSERT INTO public_characters (
              clerk_id,
              name,
              subtitle,
              description,
              conversation_style,
              model_name
          ) VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING *;
      `;
      const values = [
        clerkId,
        name,
        subtitle,
        description,
        conversationStyle,
        modelName,
      ];
      const { rows } = await pool.query(insertQuery, values);
      return res.status(201).json({ data: rows });
    }
  } catch (error) {
    console.error('Error creating/updating public character:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// DELETE /publicCharacters/:id
// Delete a public character by ID
// --------------------------------------------------------------------
app.delete('/publicCharacters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Missing id.' });
    }

    const deleteQuery = `
        DELETE FROM public_characters
        WHERE id = $1
            RETURNING *;
    `;
    const { rows } = await pool.query(deleteQuery, [id]);
    return res.status(200).json({ data: rows });
  } catch (error) {
    console.error('Error deleting public character:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// POST /publicCharacters/:id/toggle-like
// Toggle a user's "like" on a *character*
// --------------------------------------------------------------------
app.post('/publicCharacters/:id/toggle-like', async (req, res) => {
  try {
    const { id } = req.params;
    const { userClerkId } = req.body;
    if (!id || !userClerkId) {
      return res
        .status(400)
        .json({ error: 'Missing character id or userClerkId.' });
    }

    // 1) Check if user already liked this character
    const findLikeQuery = `
        SELECT *
        FROM user_likes
        WHERE user_clerk_id = $1 AND character_id = $2
            LIMIT 1;
    `;
    const { rows: likeRows } = await pool.query(findLikeQuery, [
      userClerkId,
      id,
    ]);

    if (likeRows.length === 0) {
      // Not liked -> Insert
      const insertLike = `
          INSERT INTO user_likes (user_clerk_id, character_id)
          VALUES ($1, $2);
      `;
      await pool.query(insertLike, [userClerkId, id]);

      // Increment likes_count
      const updateLikesQuery = `
          UPDATE public_characters
          SET likes_count = likes_count + 1
          WHERE id = $1
              RETURNING *;
      `;
      const { rows: updatedChar } = await pool.query(updateLikesQuery, [id]);
      return res.json({ data: updatedChar[0], liked: true });
    } else {
      // Already liked -> Remove it
      const removeLike = `
          DELETE FROM user_likes
          WHERE user_clerk_id = $1 AND character_id = $2;
      `;
      await pool.query(removeLike, [userClerkId, id]);

      // Decrement
      const updateLikesQuery = `
          UPDATE public_characters
          SET likes_count = GREATEST(likes_count - 1, 0)
          WHERE id = $1
              RETURNING *;
      `;
      const { rows: updatedChar } = await pool.query(updateLikesQuery, [id]);
      return res.json({ data: updatedChar[0], liked: false });
    }
  } catch (error) {
    console.error('Error toggling like:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// POST /publicCharacters/:id/increment-download
// Increments the download counter by 1
// --------------------------------------------------------------------
app.post('/publicCharacters/:id/increment-download', async (req, res) => {
  try {
    const { id } = req.params;
    const updateDownloadsQuery = `
        UPDATE public_characters
        SET downloads_count = downloads_count + 1
        WHERE id = $1
            RETURNING *;
    `;
    const { rows } = await pool.query(updateDownloadsQuery, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Character not found' });
    }
    return res.json({ data: rows[0] });
  } catch (error) {
    console.error('Error incrementing downloads:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// GET /liked-characters/:userClerkId
// Returns all public_characters that user has liked
// --------------------------------------------------------------------
app.get('/liked-characters/:userClerkId', async (req, res) => {
  try {
    const { userClerkId } = req.params;
    if (!userClerkId) {
      return res.status(400).json({ error: 'No userClerkId provided.' });
    }

    const query = `
        SELECT c.*
        FROM public_characters c
                 JOIN user_likes ul ON c.id = ul.character_id
        WHERE ul.user_clerk_id = $1
        ORDER BY c.likes_count DESC
    `;
    const { rows } = await pool.query(query, [userClerkId]);
    return res.json({ data: rows });
  } catch (error) {
    console.error('Error fetching liked characters:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// GET /publishedCharacters/:clerkId
// Returns all public_characters belonging to a specific clerkId
// --------------------------------------------------------------------
app.get('/publishedCharacters/:clerkId', async (req, res) => {
  try {
    const { clerkId } = req.params;
    if (!clerkId) {
      return res.status(400).json({ error: 'Missing clerkId param.' });
    }

    const query = `
        SELECT *
        FROM public_characters
        WHERE clerk_id = $1
        ORDER BY updated_at DESC
    `;
    const { rows } = await pool.query(query, [clerkId]);
    return res.json({ data: rows });
  } catch (error) {
    console.error('Error fetching published characters by clerkId:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------------------------------------------------------
// Start the server
// --------------------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Express server running on port ${port}...`);
});
