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

const supabase = createClient(supabaseUrl, supabaseKey);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Botları kontrol eden ve eksik olanları anında ekleyen fonksiyon
async function ensureBotsExist(requiredBots: BotPersona[]) {
  const usernames = requiredBots.map((b) => b.username);

  const { data: existingProfiles } = await supabase
    .from('profiles')
    .select('id, username')
    .in('username', usernames);

  const foundMap = new Map<string, string>();
  existingProfiles?.forEach((p) => foundMap.set(p.username, p.id));

  // Eksik olan botları tespit et ve tek tek oluştur
  for (const bot of requiredBots) {
    if (foundMap.has(bot.username)) continue;

    console.log(`⚡ Profil bulunamadı, otomatik oluşturuluyor: @${bot.username}`);

    try {
      // 1. Auth kullanıcısı var mı kontrol et / yoksa oluştur
      const { data: newUser, error: authError } = await supabase.auth.admin.createUser({
        email: bot.email,
        password: 'BotPasswordSecure123!',
        email_confirm: true,
        user_metadata: { username: bot.username },
      });

      let userId = newUser?.user?.id;

      if (authError) {
        // Zaten kayıtlıysa auth listesinden id'yi bul
        const { data: usersData } = await supabase.auth.admin.listUsers();
        const existing = usersData?.users?.find((u) => u.email === bot.email);
        userId = existing?.id;
      }

      if (!userId) continue;

      // 2. Profiles tablosuna kaydet
      await supabase.from('profiles').upsert({
        id: userId,
        username: bot.username,
        bio: bot.bio,
        avatar_url: bot.avatar_url,
      });

      foundMap.set(bot.username, userId);
      console.log(`✅ @${bot.username} başarıyla eklendi.`);
    } catch (e: any) {
      console.error(`✕ @${bot.username} oluşturma hatası:`, e?.message);
    }
  }

  return foundMap;
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
      console.error('❌ Hata: runner_en.ts için işlenecek US/İngilizce başlık bulunamadı!');
      process.exit(1);
    }
    targetTopicId = topics[0].topic_id;
    targetTopicName = topics[0].topic_name;
  }

  console.log(`🎯 Hedef US Başlık: #${targetTopicName} (topic_id: ${targetTopicId})`);

  // Mevcut yorumları bağlam (context) olarak al
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

  console.log(`🔍 Seçilen ${selectedBots.length} bot kontrol ediliyor...`);
  const profileIdMap = await ensureBotsExist(selectedBots);

  console.log(`📋 Bu başlığa toplam ${selectedBots.length} bot sırayla İngilizce entry girecek.\n`);

  for (let i = 0; i < selectedBots.length; i++) {
    const bot = selectedBots[i];
    const profileId = profileIdMap.get(bot.username);

    if (!profileId) {
      console.warn(`⚠️ @${bot.username} profili temin edilemedi, geçiliyor.`);
      continue;
    }

    console.log(`✍️ [${i + 1}/${selectedBots.length}] @${bot.username} hazırlanıyor...`);

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

  console.log(`\n🎉 #${targetTopicName} başlığına ait yorumlar başarıyla tamamlandı!`);
}

runEnglishBotFlow();
