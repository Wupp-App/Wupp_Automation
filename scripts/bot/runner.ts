import { supabase } from './config';
import { botPersonas } from './personas';
import { generateEntry } from './generator';

// Rastgele bekleme fonksiyonu (ms cinsinden)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBotFlow() {
  console.log('🚀 En son açılan başlık aranıyor...');

  // 1. En güncel başlığı çek
  const { data: topics, error: topicError } = await supabase
    .from('topics')
    .select('topic_id, topic_name')
    .order('created_at', { ascending: false })
    .limit(1);

  if (topicError || !topics || topics.length === 0) {
    console.error('❌ Başlık bulunamadı veya veritabanı hatası:', topicError);
    return;
  }

  const currentTopic = topics[0];
  console.log(`🎯 Hedef Başlık: #${currentTopic.topic_name} (ID: ${currentTopic.topic_id})`);

  // 2. Mevcut entry'leri al (AI'a bağlam vermek için)
  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', currentTopic.topic_id)
    .order('created_at', { ascending: true })
    .limit(10);

  const existingEntries = existingEntriesData?.map((e) => e.entry) || [];

  // 3. Botları karıştır ve bir kısmını seç (örneğin 10-15 botluk doğal bir akış)
  const shuffledBots = [...botPersonas].sort(() => 0.5 - Math.random());
  // Tek seferde 10-15 bot yorum yazması çok daha doğal ve güvenlidir
  const selectedBots = shuffledBots.slice(0, Math.min(15, shuffledBots.length));

  console.log(`👉 #${currentTopic.topic_name} başlığı için ${selectedBots.length} bot sıraya alındı.\n`);

  for (let i = 0; i < selectedBots.length; i++) {
    const bot = selectedBots[i];
    console.log(`✍️ [${i + 1}/${selectedBots.length}] @${bot.username} yorum üretiyor...`);

    // Bot profili id'sini al
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', bot.username)
      .single();

    if (!profile) {
      console.warn(`⚠️ @${bot.username} için veritabanında profil bulunamadı, atlanıyor.`);
      continue;
    }

    // AI ile entry üret
    const generatedText = await generateEntry(currentTopic.topic_name, bot, existingEntries);

    if (!generatedText) {
      console.warn(`⚠️ @${bot.username} için metin üretilemedi, atlanıyor.`);
      continue;
    }

    // Entry'yi kaydet
    const { data: newEntry, error: insertError } = await supabase
      .from('entries')
      .insert({
        topic_id: currentTopic.topic_id,
        user_id: profile.id,
        entry: generatedText,
        likes: Math.floor(Math.random() * 15) + 1, // 1-15 arası rastgele beğeni
      })
      .select()
      .single();

    if (insertError) {
      console.error(`❌ @${bot.username} entry kaydedilemedi:`, insertError.message);
    } else {
      console.log(`✅ [Entry #${newEntry.id || ''}] @${bot.username}: "${generatedText}"`);
      existingEntries.push(generatedText);
    }

    // Son bot değilse araya rastgele 15-30 saniye bekleme koy (Kota ve kilitlenmeyi önler)
    if (i < selectedBots.length - 1) {
      const waitSeconds = Math.floor(Math.random() * (30 - 15 + 1)) + 15;
      console.log(`⏳ Sonraki bot için ${waitSeconds} saniye bekleniyor...\n`);
      await sleep(waitSeconds * 1000);
    }
  }

  console.log('\n🏁 Tüm bot yorumları başarıyla tamamlandı!');
}

runBotFlow();
