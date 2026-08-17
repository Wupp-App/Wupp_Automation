import { supabaseAdmin } from './config';
import { BOT_PERSONAS } from './personas';

async function initBots() {
  console.log('🤖 Bot hesapları kontrol ediliyor...');

  for (const bot of BOT_PERSONAS) {
    // 1. Profil tablosunda var mı?
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('username', bot.username)
      .maybeSingle();

    if (existingProfile) {
      console.log(`✓ @${bot.username} zaten kayıtlı.`);
      continue;
    }

    // 2. Auth kullanıcısı oluştur
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: bot.email,
      password: 'BotPasswordSecure123!',
      email_confirm: true,
      user_metadata: { username: bot.username },
    });

    if (authError || !authUser.user) {
      console.error(`✕ ${bot.username} auth oluşturulamadı:`, authError?.message);
      continue;
    }

    // 3. Profiles tablosuna ekle/güncelle
    const { error: profError } = await supabaseAdmin.from('profiles').upsert({
      id: authUser.user.id,
      username: bot.username,
      bio: bot.bio,
    });

    if (profError) {
      console.error(`✕ ${bot.username} profili güncellenemedi:`, profError.message);
    } else {
      console.log(`✅ @${bot.username} (${bot.email}) başarıyla oluşturuldu.`);
    }
  }

  console.log('🎉 Tüm bot hesapları hazırlandı.');
}

initBots();