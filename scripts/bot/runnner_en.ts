import { createClient } from '@supabase/supabase-js';
import { BOT_PERSONAS, BotPersona } from './personas';
import { generateEntry } from './generator_en';
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

// [min, max] aralığında (dahil) rastgele tam sayı üretir
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function runEnglishBotFlow() {
  // script_en.py'den gelen topic_id ve topic_name argümanları
  const args = process.argv.slice(2);
  let targetTopicId: string | number | null = args[0] ? parseInt(args[0], 10) : null;
  let targetTopicName: string | null = args.slice(1).join(' ') || null;

  // Eğer parametre verilmediyse DB'deki 'en' sütunu işaretli en son başlığı çek
  if (!targetTopicId || !targetTopicName) {
    const { data: topics, error } = await supabase
      .from('topics')
      .select('topic_id, topic_name')
      .eq('US', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !topics || topics.length === 0) {
      console.error('❌ Hata: İşlenecek İngilizce başlık bulunamadı.');
      process.exit(1);
    }
    targetTopicId = topics[0].topic_id;
    targetTopicName = topics[0].topic_name;
  }

  console.log(`🎯 [EN Başlık] #${targetTopicName} (topic_id: ${targetTopicId})`);

  // Mevcut entry'leri bağlam (context) olarak çek
  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', targetTopicId)
    .order('created_at', { ascending: true })
    .limit(15);

  const contextEntries: string[] = existingEntriesData?.map((e) => e.entry) || [];

  // 10 ile 20 arasında rastgele bot adedi seçimi
  const targetBotCount = randomInt(10, 20);
  const shuffledBots = [...BOT_PERSONAS].sort(() => 0.5 - Math.random());
  const selectedBots: BotPersona[] = shuffledBots.slice(0, Math.min(targetBotCount, shuffledBots.length));

  console.log(`📋 Bu başlığa toplam ${selectedBots.length} bot sırayla İngilizce entry girecek.\n`);

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

    // generator_en.ts üzerinden İngilizce entry üretimi (tam cümle kontrolü, 2-5 cümle hedefi)
    const generatedText = await generateEntry(targetTopicName!, bot, contextEntries);

    // Her entry için 5 ile 35 arasında rastgele beğeni sayısı belirlenir
    const randomLikes = randomInt(5, 35);

    const { error: insertError } = await supabase
      .from('entries')
      .insert({
        topic_id: targetTopicId,
        user_id: profile.id,
        entry: generatedText,
        likes: randomLikes,
      });

    if (insertError) {
      console.error(`✕ Entry eklenemedi (@${bot.username}):`, insertError.message);
    } else {
      console.log(`✅ [${i + 1}/${selectedBots.length}] @${bot.username} (${randomLikes} fav): "${generatedText}"`);
      contextEntries.push(generatedText);
    }

    // Rate-limit ve doğal görünüm koruması: her entry arası 10-18 sn bekleme
    if (i < selectedBots.length - 1) {
      const waitTimeSec = randomInt(10, 18);
      console.log(`⏳ Kota koruması için ${waitTimeSec} sn bekleniyor...\n`);
      await sleep(waitTimeSec * 1000);
    }
  }

  console.log(`\n🎉 #${targetTopicName} başlığına ait ${selectedBots.length} İngilizce yorum başarıyla tamamlandı!`);
}

runEnglishBotFlow();
