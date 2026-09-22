import { MongoClient } from 'mongodb';
import { config } from '../config.js';

/**
 * Lazy singleton connection to the bot's own database (CA-Guru-bot). Indexes are created on
 * first connect; createIndex is idempotent, so this is safe on every boot.
 */
let client;
let connecting;

const WEEK = 7 * 86_400;

async function connect() {
  client ??= new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 5000 });
  connecting ??= client
    .connect()
    .then(async (connected) => {
      const db = connected.db(config.mongo.dbName);
      await Promise.all([
        db.collection('messages').createIndex({ waId: 1, createdAt: -1 }),
        db.collection('messages').createIndex({ createdAt: -1 }),
        db.collection('handovers').createIndex({ waId: 1 }, { unique: true }),
        db.collection('optouts').createIndex({ waId: 1 }, { unique: true }),
        db.collection('activations').createIndex({ waId: 1 }, { unique: true }),
        // wacrm may deliver an event twice; a week of ids is plenty.
        db.collection('webhook_events').createIndex({ eventId: 1 }, { unique: true }),
        db.collection('webhook_events').createIndex({ createdAt: 1 }, { expireAfterSeconds: WEEK }),
        // Every wamid this bot sent, so a message.sent we did NOT send reads as a staff reply.
        db.collection('sent').createIndex({ wamid: 1 }, { unique: true }),
        db.collection('sent').createIndex({ createdAt: 1 }, { expireAfterSeconds: WEEK }),
      ]);
      console.log(`MongoDB connected: ${config.mongo.dbName}`);
      return connected;
    })
    .catch((err) => {
      // Let the next call retry rather than caching a failed connection forever.
      connecting = undefined;
      client = undefined;
      throw err;
    });

  return (await connecting).db(config.mongo.dbName);
}

export const getDb = () => connect();
export const collection = async (name) => (await connect()).collection(name);

export async function closeMongo() {
  const open = client;
  client = undefined;
  connecting = undefined;
  await open?.close();
}
