import { supabaseAdmin } from './config';
import { BOT_PERSONAS } from './personas';

async function initBots() {
  console.log(`🤖 Toplam ${BOT_PERSONAS.length} bot hesabı ve profil fotoğrafları senkronize ediliyor...`);

  // Auth kullanıcı listesini tek seferde çekiyoruz (hız için)
  const { data: userListData } = await supabaseAdmin.auth.admin.listUsers();
  const allUsers = userListData?.users || [];

  for (const bot of BOT_PERSONAS) {
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
        console.error(`✕ @${bot.username} auth oluşturulamadı:`, authError?.message);
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
      // Kayıt varsa (veya Supabase trigger'ı oluşturduysa) doğrudan güncelle
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
      // Kayıt hiç yoksa ekle
      const { error } = await supabaseAdmin.from('profiles').insert({
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
      console.log(`🎉 @${bot.username} profili ve fotoğrafı başarıyla güncellendi.`);
    }
  }

  console.log('✨ Tüm bot hesapları ve fotoğrafları senkronize edildi.');
}

initBots();