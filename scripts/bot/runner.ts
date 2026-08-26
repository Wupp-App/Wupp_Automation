import { createClient } from '@supabase/supabase-js';
import { BOT_PERSONAS, BotPersona } from './personas';
import { generateEntry } from './generator';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL veya Service Role Key eksik!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBotFlow() {
  // script.py'den gelen topic_id ve topic_name argümanları
  const args = process.argv.slice(2);
  let targetTopicId: string | number | null = args[0] || null;
  let targetTopicName: string | null = args.slice(1).join(' ') || null;

  // Eğer parametre verilmediyse DB'deki son başlığı çek
  if (!targetTopicId || !targetTopicName) {
    const { data: topics, error } = await supabase
      .from('topics')
      .select('topic_id, topic_name')
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !topics || topics.length === 0) {
      console.error('❌ İşlenecek başlık bulunamadı.');
      return;
    }
    targetTopicId = topics[0].topic_id;
    targetTopicName = topics[0].topic_name;
  }

  console.log(`🎯 Hedef Başlık: #${targetTopicName} (ID: ${targetTopicId})`);

  // Mevcut entry'leri bağlam (context) olarak al
  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', targetTopicId)
    .order('created_at', { ascending: true })
    .limit(15);

  const contextEntries: string[] = existingEntriesData?.map((e) => e.entry) || [];

  // 10 ile 40 arasında rastgele sayıda bot seç
  const targetBotCount = Math.floor(Math.random() * (40 - 10 + 1)) + 10;
  const shuffledPersonas = [...BOT_PERSONAS].sort(() => 0.5 - Math.random());
  const selectedBots: BotPersona[] = shuffledPersonas.slice(0, Math.min(targetBotCount, shuffledPersonas.length));

  console.log(`👉 Toplam ${selectedBots.length} bot sırayla entry girecek.\n`);

  for (let i = 0; i < selectedBots.length; i++) {
    const bot = selectedBots[i];
    console.log(`✍️ [${i + 1}/${selectedBots.length}] @${bot.username} hazırlanıyor...`);

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', bot.username)
      .maybeSingle();

    if (!profile) {
      console.warn(`⚠️ @${bot.username} profili bulunamadı, geçiliyor.`);
      continue;
    }

    const generatedText = await generateEntry(targetTopicName!, bot, contextEntries);

    const { data: newEntry, error: insertError } = await supabase
      .from('entries')
      .insert({
        topic_id: targetTopicId,
        user_id: profile.id,
        entry: generatedText,
        likes: Math.floor(Math.random() * 12) + 1,
      })
      .select()
      .single();

    if (insertError) {
      console.error(`✕ Entry ekleme hatası (@${bot.username}):`, insertError.message);
    } else {
      console.log(`✅ [${i + 1}/${selectedBots.length}] @${bot.username}: "${generatedText}"`);
      contextEntries.push(generatedText);
    }

    // Rate-limit ve kota koruması için her entry arasına 12-20 sn bekleme
    if (i < selectedBots.length - 1) {
      const waitTimeSec = Math.floor(Math.random() * (20 - 12 + 1)) + 12;
      console.log(`⏳ Kota koruması için ${waitTimeSec} sn bekleniyor...\n`);
      await sleep(waitTimeSec * 1000);
    }
  }

  console.log(`\n🎉 #${targetTopicName} başlığına ait ${selectedBots.length} yorum başarıyla tamamlandı!`);
}

runBotFlow();
