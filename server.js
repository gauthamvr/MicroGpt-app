// server.js

require('dotenv').config(); // Loads .env variables like DATABASE_URL, CLERK_SECRET_KEY, etc.
const express = require('express');
const cors = require('cors');
const { pool, initDB } = require('./db');
initDB();
const app = express();

// Let’s allow cross-origin requests:
app.use(cors());

// Enable JSON body parsing:
app.use(express.json());

// -----------------------------------------
// POST /users
// For creating user records in the DB
// -----------------------------------------
app.post('/users', async (req, res) => {
  try {
    const { name, email, clerkId } = req.body;

    if (!name || !email || !clerkId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Insert user into "users" table
    const query = `
      INSERT INTO users (name, email, clerk_id)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const values = [name, email, clerkId];
    const result = await pool.query(query, values);

    return res.status(201).json({ data: result.rows });
  } catch (error) {
    console.error('Error creating user:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// -----------------------------------------
// GET /publicCharacters?sortBy=likes or downloads
// Returns top 20 public characters
// -----------------------------------------
app.get('/publicCharacters', async (req, res) => {
  try {
    const sortBy = req.query.sortBy;
    let orderColumn = 'likes_count'; // default is sorting by likes

    if (sortBy === 'downloads') {
      orderColumn = 'downloads_count';
    }

    const query = `
      SELECT *
      FROM public_characters
      ORDER BY ${orderColumn} DESC
      LIMIT 20
    `;
    const { rows } = await pool.query(query);
    return res.json({ data: rows });
  } catch (error) {
    console.error('Error fetching public characters:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// -----------------------------------------
// POST /publicCharacters
// Create or update a character
// -----------------------------------------
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

// -----------------------------------------
// DELETE /publicCharacters/:id
// Delete a public character by ID
// -----------------------------------------
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

// -----------------------------------------
// POST /publicCharacters/:id/toggle-like
// Toggle a user's like on a character
// -----------------------------------------
app.post('/publicCharacters/:id/toggle-like', async (req, res) => {
  try {
    const { id } = req.params;
    const { userClerkId } = req.body;
    if (!id || !userClerkId) {
      return res
        .status(400)
        .json({ error: 'Missing character id or userClerkId.' });
    }

    // Check if user already liked
    const findLikeQuery = `
        SELECT * FROM user_likes
        WHERE user_clerk_id = $1 AND character_id = $2
            LIMIT 1
    `;
    const { rows: likeRows } = await pool.query(findLikeQuery, [
      userClerkId,
      id,
    ]);

    if (likeRows.length === 0) {
      // Not liked -> Insert
      const insertLike = `
        INSERT INTO user_likes (user_clerk_id, character_id)
        VALUES ($1, $2)
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
        WHERE user_clerk_id = $1 AND character_id = $2
      `;
      await pool.query(removeLike, [userClerkId, id]);

      // Decrement likes_count
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

// -----------------------------------------
// POST /publicCharacters/:id/increment-download
// Increments the download counter by 1
// -----------------------------------------
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

// -----------------------------------------
// GET /liked-characters/:userClerkId
// Returns all public_characters that user has liked
// -----------------------------------------
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

// -----------------------------------------
// NEW ROUTE: GET /publishedCharacters/:clerkId
// Returns all public_characters belonging to a specific clerkId
// -----------------------------------------
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

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Express server running on port ${port}...`);
});
