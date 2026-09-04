import { supabaseAdmin } from './config';
import { BOT_PERSONAS_EN } from './personas_en';

async function initEnglishBots() {
  console.log(`🤖 Toplam ${BOT_PERSONAS_EN.length} İngilizce bot hesabı senkronize ediliyor...`);

  // Auth kullanıcı listesini tek seferde çekiyoruz
  const { data: userListData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  
  if (listError) {
    console.error('❌ Kullanıcı listesi alınamadı:', listError.message);
    return;
  }

  const allUsers = userListData?.users || [];

  for (const bot of BOT_PERSONAS_EN) {
    let userId: string | null = null;

    // 1. Auth tarafında bu email var mı kontrol et
    const existingAuth = allUsers.find((u) => u.email === bot.email);

    if (existingAuth) {
      userId = existingAuth.id;
      console.log(`ℹ️ Auth hesabı mevcut: @${bot.username}`);
    } else {
      // Yoksa Auth kullanıcısını oluştur
      const { data: newUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: bot.email,
        password: 'BotPasswordSecure123!',
        email_confirm: true,
        user_metadata: { username: bot.username },
      });

      if (authError || !newUser.user) {
        console.error(`✕ @${bot.username} auth hesabı oluşturulamadı:`, authError?.message);
        continue;
      }
      userId = newUser.user.id;
      console.log(`✅ Yeni auth hesabı açıldı: @${bot.username}`);
    }

    if (!userId) continue;

    // 2. Profiles tablosunda kayıt var mı kontrol et
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    let profileError;
    if (existingProfile) {
      const { error } = await supabaseAdmin
        .from('profiles')
        .update({
          username: bot.username,
          bio: bot.bio,
          avatar_url: bot.avatar_url,
        })
        .eq('id', userId);
      profileError = error;
    } else {
      const { error } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: userId,
          username: bot.username,
          bio: bot.bio,
          avatar_url: bot.avatar_url,
        });
      profileError = error;
    }

    if (profileError) {
      console.error(`✕ @${bot.username} profiles tablosuna eklenemedi:`, profileError.message);
    } else {
      console.log(`🎉 @${bot.username} profili ve fotoğrafı hazır.`);
    }
  }

  console.log('\n✨ Tüm İngilizce bot hesapları başarıyla senkronize edildi!');
}

initEnglishBots();
