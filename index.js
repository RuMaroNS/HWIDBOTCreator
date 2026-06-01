const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Инициализация
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SUPER_ADMIN = "6176762600";
const KEYS_PER_PAGE = 4;

// Временное хранилище состояний для ожидания ввода текста
const userSessions = {};

// Функция проверки: является ли пользователь админом
async function isAdmin(userId, username) {
    if (String(userId) === SUPER_ADMIN) return true;
    
    // Проверяем по ID
    let { data: adminId } = await supabase.from('bot_admins').select('*').eq('user_id', String(userId));
    if (adminId && adminId.length > 0) return true;

    // Проверяем по Username (если есть)
    if (username) {
        let { data: adminUser } = await supabase.from('bot_admins').select('*').eq('user_id', username.toLowerCase());
        if (adminUser && adminUser.length > 0) return true;
    }
    return false;
}

// Генератор ключей (формат: xxxx-HWID-TEST-xxxx из строчных букв и цифр)
function generateKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const genPart = (len) => Array.from({length: len}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${genPart(4)}-HWID-${genPart(4)}-${genPart(4)}`;
}

// Главное меню
const mainMenu = Markup.keyboard([
    ['создать ключ HWID'],
    ['активные ключи HWID', 'Настройки бота']
]).resize();

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    
    if (!(await isAdmin(userId, username))) {
        return ctx.reply("❌ Доступ заблокирован. Вы не являетесь администратором.");
    }
    
    ctx.reply("👋 Добро пожаловать в панель управления NoobleScript!", mainMenu);
});

// Слушатель обычного текста (для добавления админов и создания своего графика)
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    // 1. Логика добавления админа (твоя старая)
    if (userSessions[userId] === 'await_admin_input') {
        delete userSessions[userId];
        
        let target = text.trim().replace('@', '');
        
        const { error } = await supabase.from('bot_admins').insert({
            user_id: target.toLowerCase(),
            added_by: String(userId)
        });

        if (error) {
            return ctx.reply("❌ Ошибка: Этот пользователь уже есть в списке админов или произошел сбой.");
        }

        return ctx.reply(`✅ Пользователь "${target}" успешно добавлен в базу администраторов!\nВсе, что ему нужно — зайти в бота и прописать /start`);
    }

    // 2. Логика обработки кастомного графика (Новая)
    if (userSessions[userId] === 'await_custom_graph') {
        if (!text.includes('/')) {
            return ctx.reply("❌ Ошибка! Отсутствует разделитель `/`. Попробуйте еще раз в формате `ГГГГ.ММ.ДД / Название подписки` или нажмите кнопку отмены.");
        }

        const parts = text.split('/');
        const datePart = parts[0].trim().replace(/\./g, '-'); // Заменяем точки на дефисы для корректного чтения даты
        let tierName = parts[1].trim();

        // Умная проверка кавычек: если их нет — добавляем
        const hasQuotes = /^([\"'])(.*)\1$/.test(tierName);
        if (!hasQuotes) {
            tierName = `"${tierName}"`;
        }

        // Парсим дату и выставляем конец дня (23:59:59)
        const expiresAt = new Date(`${datePart}T23:59:59`);
        if (isNaN(expiresAt.getTime())) {
            return ctx.reply("❌ Неверный формат даты! Убедитесь, что написали правильно, например: `2026.05.20 / Окак`");
        }

        delete userSessions[userId]; // Сбрасываем сессию только после успешной валидации
        const newKey = generateKey();

        // Записываем в базу данных (включая кастомный tier)
        const { error } = await supabase.from('keys').insert({
            key: newKey,
            expires_at: expiresAt.toISOString(),
            status: 'active',
            tier: tierName 
        });

        if (error) {
            return ctx.reply(`❌ Не удалось сохранить ключ в базу данных: ${error.message}`);
        }

        return ctx.reply(`✅ **Кастомный ключ успешно создан!**\n\n` +
                         `🔑 Ключ: \`${newKey}\`\n` +
                         `💎 Название подписки: *${tierName}*\n` +
                         `⏳ Действует до: ${expiresAt.toLocaleString('ru-RU')}\n\n` +
                         `👉 Отправь его покупателю. Скрипт сам привяжет его HWID при входе.`, 
                         { parse_mode: 'Markdown' });
    }

    return next();
});

// Нажатие: "создать ключ HWID" (Добавлена кнопка создания своего графика)
bot.hears('создать ключ HWID', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return;
    
    const inlineMenu = Markup.inlineKeyboard([
        [Markup.button.callback('12 часов', 'gen_12h'), Markup.button.callback('24 часа', 'gen_24h')],
        [Markup.button.callback('3 дня', 'gen_3d'), Markup.button.callback('7 дней', 'gen_7d')],
        [Markup.button.callback('⚙️ Создать свой график', 'gen_custom_prompt')]
    ]);
    ctx.reply("⏱ Выберите срок действия лицензионного ключа:", inlineMenu);
});

// Обработка генерации стандартных ключей (Твоя логика, 12 часов на месте!)
const timeMaps = { '12h': 12*60, '24h': 24*60, '3d': 3*24*60, '7d': 7*24*60 };
bot.action(/^gen_(12h|24h|3d|7d)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    
    const durationType = ctx.match[1];
    const minutes = timeMaps[durationType];
    
    const newKey = generateKey();
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

    const { error } = await supabase.from('keys').insert({
        key: newKey,
        expires_at: expiresAt,
        status: 'active',
        tier: durationType // Записываем стандартное имя тарифа, чтобы не было пустым
    });

    if (error) {
        return ctx.reply("❌ Не удалось сохранить ключ в базу данных.");
    }

    ctx.editMessageText(`✅ **Ключ успешно создан!**\n\n` +
                       `🔑 Ключ: \`${newKey}\`\n` +
                       `⏳ Действует до: ${new Date(expiresAt).toLocaleString('ru-RU')}\n\n` +
                       `👉 Отправь его покупателю. Скрипт сам привяжет его HWID при входе.`, 
                       { parse_mode: 'Markdown' });
});

// Обработка нажатия кнопки "Создать свой график"
bot.action('gen_custom_prompt', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    
    userSessions[ctx.from.id] = 'await_custom_graph';
    ctx.answerCbQuery();
    
    return ctx.editMessageText('⚙️ **Режим создания своего графика**\n\n' +
                               'Пришлите сообщение строго в формате:\n' +
                               '`ГГГГ.ММ.ДД / Название подписки` \n\n' +
                               '*Пример:* `2026.05.20 / Окак` \n\n' +
                               '_(Если вы забудете кавычки, бот автоматически добавит их сам)_', 
                               { parse_mode: 'Markdown' });
});

// Нажатие: "Настройки бота"
bot.hears('Настройки бота', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return;
    
    ctx.reply("⚙️ Настройки бота:", Markup.inlineKeyboard([
        [Markup.button.callback("➕ Добавить админа", "add_admin_prompt")]
    ]));
});

bot.action("add_admin_prompt", async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    userSessions[ctx.from.id] = 'await_admin_input';
    ctx.reply("✉️ Отправьте мне **ID** пользователя или его **Username** (можно без @), которого хотите сделать администратором:");
    ctx.answerCbQuery();
});

// Нажатие: "активные ключи HWID"
bot.hears('активные ключи HWID', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return;
    sendKeysPage(ctx, 0, false);
});

// Функция вывода списка ключей с постраничной навигацией (пагинация по 4 шт)
async function sendKeysPage(ctx, page, isEdit = true) {
    const { data: allKeys, error } = await supabase.from('keys').select('*').order('id', { ascending: false });
    
    if (error || !allKeys || allKeys.length === 0) {
        const text = "📭 Активных ключей в базе данных не обнаружено.";
        return isEdit ? ctx.editMessageText(text) : ctx.reply(text);
    }

    const totalPages = Math.ceil(allKeys.length / KEYS_PER_PAGE);
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;

    const startIdx = page * KEYS_PER_PAGE;
    const pageKeys = allKeys.slice(startIdx, startIdx + KEYS_PER_PAGE);

    let msgText = `📋 **Список активных ключей (Страница ${page + 1}/${totalPages}):**\n\n`;
    const inlineButtons = [];

    pageKeys.forEach((k, index) => {
        const displayIdx = startIdx + index + 1;
        const hwidStatus = k.hwid ? "🔒 Привязан" : "🔓 Свободен";
        // Если у ключа есть имя подписки (tier), выводим его тоже
        const tierInfo = k.tier ? ` [${k.tier}]` : "";
        msgText += `${displayIdx}. \`${k.key}\`${tierInfo} [${hwidStatus}]\n`;
        
        inlineButtons.push([Markup.button.callback(`🔍 Посмотреть номер [${displayIdx}]`, `view_key_${k.id}_${page}`)]);
    });

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback("⬅️ Назад", `page_${page - 1}`));
    if (page < totalPages - 1) navRow.push(Markup.button.callback("Вперед ➡️", `page_${page + 1}`));
    
    if (navRow.length > 0) {
        inlineButtons.push(navRow);
    }

    if (isEdit) {
        ctx.editMessageText(msgText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
    } else {
        ctx.reply(msgText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
    }
}

// Переключение страниц
bot.action(/^page_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const targetPage = parseInt(ctx.match[1]);
    sendKeysPage(ctx, targetPage, true);
    ctx.answerCbQuery();
});

// Просмотр детальной информации о книге
bot.action(/^view_key_(.+)_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const keyId = ctx.match[1];
    const backPage = parseInt(ctx.match[2]);

    const { data } = await supabase.from('keys').select('*').eq('id', keyId);
    if (!data || data.length === 0) {
        return ctx.answerCbQuery("Ключ не найден.", { show_alert: true });
    }

    const k = data[1] || data[0];
    const hwidInfo = k.hwid ? `\`${k.hwid}\`` : "Не активирован (ожидает первого входа)";
    const tierDetails = k.tier ? `\n• **Тариф:** ${k.tier}` : "";
    
    const details = `🔑 **Информация о ключе:**\n\n` +
                    `• **Ключ:** \`${k.key}\`${tierDetails}\n` +
                    `• **HWID:** ${hwidInfo}\n` +
                    `• **Статус:** \`${k.status}\`\n` +
                    `• **Истекает:** ${new Date(k.expires_at).toLocaleString('ru-RU')}\n` +
                    `• **Создан:** Администратором бота\n`;

    const actions = Markup.inlineKeyboard([
        [Markup.button.callback("🗑 Удалить код HWID", `delete_key_${k.id}_${backPage}`)],
        [Markup.button.callback("⬅️ К списку", `page_${backPage}`)]
    ]);

    ctx.editMessageText(details, { parse_mode: 'Markdown', ...actions });
    ctx.answerCbQuery();
});

// Удаление ключа
bot.action(/^delete_key_(.+)_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const keyId = ctx.match[1];
    const backPage = parseInt(ctx.match[2]);

    const { error } = await supabase.from('keys').delete().eq('id', keyId);

    if (error) {
        return ctx.answerCbQuery("Не удалось удалить ключ.", { show_alert: true });
    }

    ctx.answerCbQuery("Ключ успешно удален!", { show_alert: false });
    sendKeysPage(ctx, backPage, true);
});

// Запуск
bot.launch().then(() => console.log("🚀 Бот запущен через систему GitHub Actions!"));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
                  
