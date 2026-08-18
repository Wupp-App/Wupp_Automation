import { supabaseAdmin } from './config';
import { BOT_PERSONAS, BotPersona } from './personas';
import { generateEntry } from './generator';

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Rastgele 10-49 arası bot beğenisi ekleyen fonksiyon
async function addRandomBotLikes(
  entryId: number | string,
  authorBotId: string,
  allBotProfiles: { id: string; username: string }[]
): Promise<number> {
  const eligibleBots = allBotProfiles.filter((b) => b.id !== authorBotId);
  if (eligibleBots.length === 0) return 0;

  const minLikes = Math.min(10, eligibleBots.length);
  const maxLikes = eligibleBots.length;
  const likeCount = Math.floor(Math.random() * (maxLikes - minLikes + 1)) + minLikes;

  const shuffled = [...eligibleBots].sort(() => 0.5 - Math.random());
  const selectedBots = shuffled.slice(0, likeCount);

  const likeRows = selectedBots.map((bot) => ({
    entry_id: entryId,
    user_id: bot.id,
  }));

  const { error: likesErr } = await supabaseAdmin
    .from('entry_likes')
    .insert(likeRows);

  if (likesErr) {
    // entry_likes tablosu yoksa veya kısıt varsa sadece sayaç güncellenir
  }

  await supabaseAdmin
    .from('entries')
    .update({ likes: selectedBots.length })
    .eq('id', entryId);

  return selectedBots.length;
}

async function runBotCycle() {
  console.log('🚀 En son açılan başlık aranıyor...');

  // 1. Bot profillerini çek
  const botUsernames = BOT_PERSONAS.map((b) => b.username);
  const { data: botProfiles, error: botProfilesErr } = await supabaseAdmin
    .from('profiles')
    .select('id, username')
    .in('username', botUsernames);

  if (botProfilesErr || !botProfiles || botProfiles.length === 0) {
    console.error('Bot profilleri veritabanında bulunamadı! Önce "npm run bot:init" çalıştırın.');
    return;
  }

  const botMap = new Map(botProfiles.map((p) => [p.username, p.id]));

  // 2. Sadece EN SON açılan 1 başlığı al
  const { data: latestTopics, error: topicErr } = await supabaseAdmin
    .from('topics')
    .select('topic_id, topic_name, created_at')
    .order('created_at', { ascending: false })
    .limit(1);

  if (topicErr || !latestTopics || latestTopics.length === 0) {
    console.log('İşlenecek başlık bulunamadı.');
    return;
  }

  const topic = latestTopics[0];
  console.log(`\n🎯 Hedef Başlık: #${topic.topic_name} (ID: ${topic.topic_id})`);

  // 3. Bu başlığa daha önce yazmış botları ve mevcut entry'leri çek
  const { data: existingEntries } = await supabaseAdmin
    .from('entries')
    .select('user_id, entry')
    .eq('topic_id', topic.topic_id)
    .order('created_at', { ascending: true });

  const existingUserIds = new Set(existingEntries?.map((e) => e.user_id) || []);
  const recentEntryTexts = existingEntries?.map((e) => e.entry) || [];

  // Henüz yazmamış botları bul
  const availableBots = BOT_PERSONAS.filter((persona) => {
    const profileId = botMap.get(persona.username);
    return profileId && !existingUserIds.has(profileId);
  });

  if (availableBots.length === 0) {
    console.log(`✓ #${topic.topic_name} başlığına yazılabilecek uygun bot kalmamış.`);
    return;
  }

  // 4. 30 ile 50 arasında (veya kalan müsait bot kadar) rastgele sayıda bot seç
  const targetBotCount = Math.min(
    availableBots.length,
    Math.floor(Math.random() * (50 - 30 + 1)) + 30
  );

  const selectedBots = [...availableBots]
    .sort(() => 0.5 - Math.random())
    .slice(0, targetBotCount);

  console.log(`👉 #${topic.topic_name} başlığı için ${selectedBots.length} bot rastgele seçildi ve sıraya alındı.`);

  // 5. Seçilen botlar sırayla entry girsin
  for (const persona of selectedBots) {
    const botUserId = botMap.get(persona.username);
    if (!botUserId) continue;

    console.log(`✍️ @${persona.username} yorum üretiyor...`);

    const contextTexts = recentEntryTexts.slice(-4);
    const generatedText = await generateEntry(topic.topic_name, persona, contextTexts);

    if (!generatedText) {
      console.log(`⚠️ @${persona.username} için metin üretilemedi, atlanıyor.`);
      continue;
    }

    const { data: newEntry, error: insertErr } = await supabaseAdmin
      .from('entries')
      .insert([
        {
          topic_id: topic.topic_id,
          user_id: botUserId,
          entry: generatedText,
          likes: 0,
          reply_count: 0,
        },
      ])
      .select('id')
      .single();

    if (insertErr || !newEntry) {
      console.error(`✕ Entry eklenemedi (@${persona.username}):`, insertErr?.message);
    } else {
      console.log(`✅ [Entry #${newEntry.id}] @${persona.username}: "${generatedText}"`);
      recentEntryTexts.push(generatedText);

      // Rastgele 10-49 arası bot beğenisi ekle
      const totalLikes = await addRandomBotLikes(newEntry.id, botUserId, botProfiles);
      console.log(`❤️ Entry #${newEntry.id} için ${totalLikes} beğeni uygulandı.`);
    }

    // İstekler arası rate-limit koruma beklemesi
    await sleep(3500);
  }

  console.log(`\n✨ #${topic.topic_name} başlığı için yorum ve beğeni akışı tamamlandı.`);
}

runBotCycle();
