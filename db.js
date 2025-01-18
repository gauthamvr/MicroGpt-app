// db.js
require('dotenv').config();
const { Pool } = require('pg');

// Create a connection pool using your Neon database URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // The above SSL setting is often needed for Neon
});

// A helper function to ensure the 'public_characters' table is created
async function initDB() {
  const createTableQuery = `
      CREATE TABLE IF NOT EXISTS public_characters (
                                                       id SERIAL PRIMARY KEY,
                                                       clerk_id TEXT NOT NULL,
                                                       name TEXT NOT NULL,
                                                       subtitle TEXT NOT NULL DEFAULT '',
                                                       description TEXT NOT NULL,
                                                       conversation_style TEXT NOT NULL,
                                                       model_name TEXT NOT NULL,
                                                       likes_count INT NOT NULL DEFAULT 0,
                                                       downloads_count INT NOT NULL DEFAULT 0,
                                                       created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
  `;
  try {
    await pool.query(createTableQuery);
    console.log('public_characters table is ready.');
  } catch (err) {
    console.error('Error creating public_characters table:', err);
  }
}

module.exports = { pool, initDB };
