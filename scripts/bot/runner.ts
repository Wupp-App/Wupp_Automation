import { createClient } from '@supabase/supabase-js';
import { BOT_PERSONAS } from './personas';
import { generateEntry } from './generator';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase ortam değişkenleri eksik!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBotFlow() {
  console.log('🚀 En son açılan başlık sorgulanıyor...');

  const { data: topics, error: topicError } = await supabase
    .from('topics')
    .select('topic_id, topic_name')
    .order('created_at', { ascending: false })
    .limit(1);

  if (topicError || !topics || topics.length === 0) {
    console.error('❌ Başlık bulunamadı:', topicError);
    return;
  }

  const currentTopic = topics[0];
  console.log(`🎯 Hedef Başlık: #${currentTopic.topic_name} (ID: ${currentTopic.topic_id})`);

  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', currentTopic.topic_id)
    .order('created_at', { ascending: true })
    .limit(10);

  const existingEntries = existingEntriesData?.map((e) => e.entry) || [];

  // 20 ile 40 arasında rastgele bot adedi seçimi
  const targetCount = Math.floor(Math.random() * (40 - 20 + 1)) + 20;
  const shuffledBots = [...BOT_PERSONAS].sort(() => 0.5 - Math.random());
  const selectedBots = shuffledBots.slice(0, Math.min(targetCount, shuffledBots.length));

  console.log(`👉 Bu başlık için ${selectedBots.length} bot sıraya alındı.\n`);

  for (let i = 0; i < selectedBots.length; i++) {
    const bot = selectedBots[i];
    console.log(`✍️ [${i + 1}/${selectedBots.length}] @${bot.username} hazırlanıyor...`);

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', bot.username)
      .single();

    if (!profile) {
      console.warn(`⚠️ @${bot.username} profili bulunamadı, geçiliyor.`);
      continue;
    }

    const generatedText = await generateEntry(currentTopic.topic_name, bot, existingEntries);

    const { data: newEntry, error: insertError } = await supabase
      .from('entries')
      .insert({
        topic_id: currentTopic.topic_id,
        user_id: profile.id,
        entry: generatedText,
        likes: Math.floor(Math.random() * 15) + 1,
      })
      .select()
      .single();

    if (insertError) {
      console.error(`❌ Entry kaydedilemedi (@${bot.username}):`, insertError.message);
    } else {
      console.log(`✅ [Entry #${newEntry.id || ''}] @${bot.username}: "${generatedText}"`);
      existingEntries.push(generatedText);
    }

    // Rate-limit ve kota koruması için her entry arasına 10-18 saniye dinamik gecikme
    if (i < selectedBots.length - 1) {
      const waitMs = Math.floor(Math.random() * (18000 - 10000 + 1)) + 10000;
      console.log(`⏳ Kota koruması için ${(waitMs / 1000).toFixed(1)} sn bekleniyor...\n`);
      await sleep(waitMs);
    }
  }

  console.log('\n🏁 Seçilen tüm botların entry akışı tamamlandı!');
}

runBotFlow();
