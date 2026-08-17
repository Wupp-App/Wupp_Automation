import { supabaseAdmin } from './config';
import { BOT_PERSONAS, BotPersona } from './personas';
import { generateEntry } from './generator';

// Gemini RPM (Dakikalık istek) sınırına takılmamak için bekleme fonksiyonu
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function runBotCycle() {
  console.log('🚀 Bugünün başlıkları taranıyor...');

  // 1. Botların veritabanındaki ID eşleşmelerini çek
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

  // 2. Bugünün başlangıç zamanını hesapla (00:00:00 UTC)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  // 3. Sadece BUGÜN açılan başlıkları çek
  const { data: topics, error: topicsErr } = await supabaseAdmin
    .from('topics')
    .select('topic_id, topic_name, created_at')
    .gte('created_at', todayIso)
    .order('created_at', { ascending: false });

  if (topicsErr) {
    console.error('Başlıklar çekilirken hata:', topicsErr.message);
    return;
  }

  if (!topics || topics.length === 0) {
    console.log('Bugün henüz yeni bir başlık açılmamış. Bekleniyor...');
    return;
  }

  console.log(`📌 Bugün açılmış toplam ${topics.length} başlık bulundu.`);

  // 4. Her başlık için botları sırayla konuştur
  for (const topic of topics) {
    console.log(`\n🔍 Başlık İnceleniyor: #${topic.topic_name} (ID: ${topic.topic_id})`);

    // Bu başlığa yazmış olan tüm entry'leri çek
    const { data: existingEntries } = await supabaseAdmin
      .from('entries')
      .select('user_id, entry')
      .eq('topic_id', topic.topic_id)
      .order('created_at', { ascending: true });

    const existingUserIds = new Set(existingEntries?.map((e) => e.user_id) || []);
    const recentEntryTexts = existingEntries?.map((e) => e.entry) || [];

    // Henüz bu başlığa yorum yapmamış botları bul
    const availableBots = BOT_PERSONAS.filter((persona) => {
      const profileId = botMap.get(persona.username);
      return profileId && !existingUserIds.has(profileId);
    });

    if (availableBots.length === 0) {
      console.log(`✓ #${topic.topic_name} başlığına tüm botlar zaten yazmış.`);
      continue;
    }

    console.log(`👉 #${topic.topic_name} için yazacak ${availableBots.length} bot sıraya alındı.`);

    for (const persona of availableBots) {
      const botUserId = botMap.get(persona.username);
      if (!botUserId) continue;

      console.log(`✍️ @${persona.username} yorum üretiyor...`);

      // Önceki entry'leri bağlam olarak AI'ya ver (Konudan sapmasın)
      const contextTexts = recentEntryTexts.slice(-4);
      const generatedText = await generateEntry(topic.topic_name, persona, contextTexts);

      if (!generatedText) {
        console.log(`⚠️ @${persona.username} için metin üretilemedi, atlanıyor.`);
        continue;
      }

      // Entry'yi kaydet
      const { data: newEntry, error: insertErr } = await supabaseAdmin
        .from('entries')
        .insert([
          {
            topic_id: topic.topic_id,
            user_id: botUserId,
            entry: generatedText,
            likes: Math.floor(Math.random() * 2), // 0 veya 1 beğeni
            reply_count: 0,
          },
        ])
        .select('id')
        .single();

      if (insertErr) {
        console.error(`✕ Entry eklenemedi (@${persona.username}):`, insertErr.message);
      } else {
        console.log(`✅ [Entry #${newEntry.id}] @${persona.username}: "${generatedText}"`);
        recentEntryTexts.push(generatedText);
      }

      // Gemini RPM sınırına takılmamak ve gerçekçi aralık sağlamak için 4 saniye bekle
      await sleep(4000);
    }
  }

  console.log('\n✨ Bugünün başlıkları için bot turu tamamlandı.');
}

runBotCycle();