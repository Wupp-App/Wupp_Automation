import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Lokal ortamdaysa .env.local dosyasını oku
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Supabase URL veya Service Role Key eksik!');
}

if (!geminiApiKey) {
  throw new Error('GEMINI_API_KEY eksik!');
}

// Botların auth işlemlerini ve entry girişlerini güvenle yapmak için Admin Client
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Gemini SDK Başlatma
export const genAI = new GoogleGenerativeAI(geminiApiKey);
