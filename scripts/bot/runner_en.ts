import { createClient } from '@supabase/supabase-js';
import { BOT_PERSONAS_EN, BotPersona } from './personas_en';
import { generateEntry } from './generator_en';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL veya Service Role Key eksik!');
}

// Auth Admin işlemlerini yapabilmek için persistSession false olmalıdır
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Profil veritabanında yoksa Auth ve Profiles tablosunda anında oluşturur.
 */
async function getOrCreateBotProfileId(bot: BotPersona): Promise<string | null> {
  // 1. Profiles tablosunda mevcut mu kontrol et
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', bot.username)
    .maybeSingle();

  if (existingProfile?.id) {
    return existingProfile.id;
  }

  console.log(`⚡ @${bot.username} profili eksik, sisteme kaydediliyor...`);

  // 2. Auth kullanıcısını oluştur veya mevcut olanın ID'sini al
  let userId: string | null = null;
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: bot.email,
    password: 'BotPasswordSecure123!',
    email_confirm: true,
    user_metadata: { username: bot.username },
  });

  if (authData?.user?.id) {
    userId = authData.user.id;
  } else if (authError) {
    const { data: listData } = await supabase.auth.admin.listUsers();
    const foundUser = listData?.users?.find((u) => u.email === bot.email);
    userId = foundUser?.id || null;
  }

  if (!userId) {
    console.error(`✕ @${bot.username} için Auth ID alınamadı:`, authError?.message);
    return null;
  }

  // 3. Profiles tablosuna ekle / güncelle (email alanı dahil)
  const { error: profileError } = await supabase.from('profiles').upsert({
    id: userId,
    username: bot.username,
    email: bot.email,
    bio: bot.bio,
    avatar_url: bot.avatar_url,
    is_author: true,
    daily_tokens: 10,
    tokens_used: 0,
  });

  if (profileError) {
    console.error(`✕ @${bot.username} profiles tablosuna yazılamadı:`, profileError.message);
    return null;
  }

  console.log(`✅ @${bot.username} profili başarıyla oluşturuldu.`);
  return userId;
}

async function runEnglishBotFlow() {
  const args = process.argv.slice(2);
  let targetTopicId: string | number | null = args[0] ? parseInt(args[0], 10) : null;
  let targetTopicName: string | null = args.slice(1).join(' ') || null;

  if (!targetTopicId || !targetTopicName) {
    const { data: topics, error } = await supabase
      .from('topics')
      .select('topic_id, topic_name')
      .eq('region', 'US')
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !topics || topics.length === 0) {
      console.error('❌ Hata: runner_en.ts için işlenecek US başlık bulunamadı!');
      process.exit(1);
    }
    targetTopicId = topics[0].topic_id;
    targetTopicName = topics[0].topic_name;
  }

  console.log(`🎯 Hedef US Başlık: #${targetTopicName} (topic_id: ${targetTopicId})`);

  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', targetTopicId)
    .order('created_at', { ascending: true })
    .limit(15);
  const contextEntries: string[] = existingEntriesData?.map((e) => e.entry) || [];

  // 10 ile 20 arasında rastgele bot seç
  const targetBotCount = randomInt(10, 20);
  const shuffledBots = [...BOT_PERSONAS_EN].sort(() => 0.5 - Math.random());
  const selectedBots: BotPersona[] = shuffledBots.slice(0, Math.min(targetBotCount, shuffledBots.length));

  console.log(`📋 Bu başlığa toplam ${selectedBots.length} bot sırayla İngilizce entry girecek.\n`);

  for (let i = 0; i < selectedBots.length; i++) {
    const bot = selectedBots[i];
    console.log(`✍️ [${i + 1}/${selectedBots.length}] @${bot.username} hazırlanıyor...`);

    // Profil yoksa anında oluşturup ID'sini döner
    const profileId = await getOrCreateBotProfileId(bot);

    if (!profileId) {
      console.warn(`⚠️ @${bot.username} profili temin edilemedi, geçiliyor.`);
      continue;
    }

    const generatedText = await generateEntry(targetTopicName!, bot, contextEntries);
    const randomLikes = randomInt(5, 35);

    const { error: insertError } = await supabase
      .from('entries')
      .insert({
        topic_id: targetTopicId,
        user_id: profileId,
        entry: generatedText,
        likes: randomLikes,
      });

    if (insertError) {
      console.error(`✕ Entry eklenemedi (@${bot.username}):`, insertError.message);
    } else {
      console.log(`✅ [${i + 1}/${selectedBots.length}] @${bot.username} (${randomLikes} fav): "${generatedText}"`);
      contextEntries.push(generatedText);
    }

    if (i < selectedBots.length - 1) {
      const waitTimeSec = randomInt(10, 18);
      console.log(`⏳ Kota koruması için ${waitTimeSec} sn bekleniyor...\n`);
      await sleep(waitTimeSec * 1000);
    }
  }

  console.log(`\n🎉 #${targetTopicName} başlığına ait İngilizce yorumlar başarıyla tamamlandı!`);
}

runEnglishBotFlow();
