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

// [min, max] aralığında (dahil) rastgele tam sayı üretir
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function runBotFlow() {
  const args = process.argv.slice(2);
  const targetTopicId = args[0] ? parseInt(args[0], 10) : null;
  const targetTopicName = args.slice(1).join(' ') || null;

  if (!targetTopicId || !targetTopicName) {
    console.error('❌ Hata: runner.ts çağrılırken topic_id veya topic_name verilmedi!');
    process.exit(1);
  }

  console.log(`🎯 Hedef Başlık: #${targetTopicName} (topic_id: ${targetTopicId})`);

  // Mevcut entry'leri bağlam olarak çek
  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', targetTopicId)
    .order('created_at', { ascending: true })
    .limit(15);
  const contextEntries: string[] = existingEntriesData?.map((e) => e.entry) || [];

  // 10 ile 50 arasında rastgele bot seç
  const targetBotCount = randomInt(10, 50);
  const shuffledBots = [...BOT_PERSONAS].sort(() => 0.5 - Math.random());
  const selectedBots: BotPersona[] = shuffledBots.slice(0, Math.min(targetBotCount, shuffledBots.length));

  console.log(`📋 Bu başlığa toplam ${selectedBots.length} bot sırayla entry girecek.\n`);

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

    // AI üretimi (tamamlanmış cümleler & doğal sözlük dili, 2-5 cümle generator.ts içinde belirleniyor)
    const generatedText = await generateEntry(targetTopicName, bot, contextEntries);

    // Her entry için 10 ile 50 arasında rastgele beğeni sayısı belirlenir
    const randomLikes = randomInt(10, 50);

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

    // API kota ve rate-limit koruması: her entry arası 12-20 sn bekleme
    if (i < selectedBots.length - 1) {
      const waitTimeSec = randomInt(12, 20);
      console.log(`⏳ Kota koruması için ${waitTimeSec} sn bekleniyor...\n`);
      await sleep(waitTimeSec * 1000);
    }
  }

  console.log(`\n🎉 #${targetTopicName} başlığına ait ${selectedBots.length} yorum başarıyla tamamlandı!`);
}

runBotFlow();
