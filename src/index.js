// noinspection SqlNoDataSourceInspection

require("log-timestamp");

const dotenv = require("dotenv");

const {Telegraf, Markup} = require("telegraf");
const {message, editedMessage} = require("telegraf/filters");

const LocalSession = require("telegraf-session-local");

const TogglTrackAPI = require("./toggl_track_api");

dotenv.config();

const settings = {
    debug: process.env.DEBUG === "true" || process.env.DEBUG === "1",
    botToken: process.env.BOT_TOKEN,
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 0,
    adminUsername: process.env.ADMIN_USERNAME, // for reporting problems
    databasePath: "data/sessions.json",
};
if (!settings.botToken) {
    throw new Error("env.BOT_TOKEN is not set");
}
if (settings.checkInterval < 10) {
    throw new Error("env.CHECK_INTERVAL should be greater than 10");
}

if (settings.debug) {
    console.debug("Starting with settings:", settings);
}

const timeouts = [];
const localSession = new LocalSession({
    storage: LocalSession.storageFileAsync,
    database: settings.databasePath,
});

function dbGetTokenObj(db, sessionId, token) {
    const tokens = db.chain().get("sessions").find({id: sessionId}).get("data").get("tokens").value() || [];
    for (let i = 0; i < tokens.length; ++i) {
        const tokenObj = tokens[i];
        if (tokenObj.token === token) {
            return tokenObj;
        }
    }
}

async function restoreTimerChecks(db) {
    const data = db.get("sessions").value();
    for (const session of data) {
        for (const tokenObj of session.data.tokens) {
            if (tokenObj.checking) {
                await checkTimerStatus(session.id, tokenObj.token);
            }
        }
    }
}

function initSession(session) {
    if (!("tokens" in session)) {
        session.tokens = [];
    }
}

localSession.DB.then(restoreTimerChecks);

function humanDuration(seconds) {
    let hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    hours = hours ? `${hours}h ` : "";
    let minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    minutes = minutes ? `${minutes}m ` : "";
    seconds = seconds ? `${seconds}s ` : "";
    return `${hours}${minutes}${seconds}`;
}


const checkAgainReplyMarkup = Markup.inlineKeyboard([
    Markup.button.callback("Check again", "check"),
]);
const startCheckingReplyMarkup = Markup.inlineKeyboard([
    Markup.button.callback("Start checking continuously", "start_checking"),
]);
const stopCheckingReplyMarkup = Markup.inlineKeyboard([
    Markup.button.callback("Stop", "stop_checking"),
]);

function hasToken(ctx) {
    return ctx.session.tokens.length;
}

async function checkTimerStatus(sessionId, token) {
    const db = localSession.DB;
    const tokenObj = dbGetTokenObj(db, sessionId, token);
    if (!tokenObj?.checking) {
        return;
    }
    const currentTimer = await TogglTrackAPI.currentTimer(token);
    if (currentTimer) {
        checkTimerStatusSetTimeout(sessionId, token);
        return;
    }
    delete tokenObj.checking;
    await db.write();
    const chatId = sessionId.split(":")[0];
    await bot.telegram.sendMessage(chatId, "Timer was stopped!", checkAgainReplyMarkup);
}

function checkTimerStatusSetTimeout(sessionId, token) {
    const timeout = setTimeout(async () => {
        const index = timeouts.indexOf(timeout);
        if (index !== -1) {
            timeouts.splice(index, 1);
        }
        try {
            await checkTimerStatus(sessionId, token);
        } catch (e) {
            console.error("checkTimerStatus", e);
        }
    }, settings.checkInterval * 1000);
    timeouts.push(timeout);
}

async function checkHasToken(ctx, next) {
    if (hasToken(ctx)) {
        return next();
    }
    const msg = "There's no stored token. Send it to the chat first";
    if (ctx.update.callback_query) {
        await ctx.answerCbQuery(msg, {show_alert: true});
    } else {
        await ctx.sendMessage(msg);
    }
}

async function setup(ctx, next) {
    const update = ctx.update;
    const message = update.message;
    const callbackQuery = update.callback_query;
    let action = message ? `text:${message.text}` : null;
    action ??= callbackQuery ? `action:${callbackQuery.data}` : null;
    action ??= "<empty>";
    action = action.slice(0, 30);
    const fromId = (message || callbackQuery)?.from.id || "-";
    const fromUsername = (message || callbackQuery)?.from.username || "-";
    const title = `Processing update [${ctx.update.update_id}] from [${fromId} @${fromUsername}] with text "${action}"`;
    console.time(title);
    if (ctx.chat.type === "private") {
        initSession(ctx.session);
        ctx.sessionId = localSession.getSessionKey(ctx);
        await next();
    } else {
        await ctx.sendMessage("Incorrect chat type");
    }
    console.timeEnd(title);
}

function buildTimerMessage(tokenObj) {
    const now = Math.floor(Date.now() / 1000);
    const duration = humanDuration(now + tokenObj.lastDuration); // duration - negative unix timestamp
    let msg = `Timer was started ${duration} ago\n`;
    if (tokenObj.checking) {
        msg += "Continuous checking is active";
    }
    return msg.trim();
}

async function commandCheckHandler(ctx) {
    const tokenObj = ctx.session.tokens[0];
    const currentTimer = await TogglTrackAPI.currentTimer(tokenObj.token);
    if (!currentTimer) {
        delete tokenObj.checking;
        await ctx.sendMessage("Timer is not started", checkAgainReplyMarkup);
        return;
    }
    tokenObj.lastDuration = currentTimer.duration;
    const msg = buildTimerMessage(tokenObj);
    await ctx.sendMessage(msg, tokenObj.checking ? stopCheckingReplyMarkup : startCheckingReplyMarkup);
}

async function commandStartHandler(ctx) {
    if (hasToken(ctx)) {
        const tokenObj = ctx.session.tokens[0];
        await ctx.sendMessage(
            `I have a token stored for "${tokenObj.username}".\n` +
            `But you can send me another one to replace it.\n` +
            `/check — to perform a timer check`,
        );
        return;
    }
    await ctx.sendMessage(
        "Send me a token.\n" +
        "You can find it here: https://track.toggl.com/profile#api-token",
    );
}

async function commandStopHandler(ctx) {
    const tokenObj = ctx.session.tokens[0];
    if (!tokenObj.checking) {
        await ctx.sendMessage("Continuous checking is not active!");
        return;
    }
    delete tokenObj.checking;
    await ctx.sendMessage("Continuous checking was stopped");
}

async function commandEditHandler(ctx) {
    await ctx.sendMessage("Simply send me a new token, I will replace the old one with it");
}

async function commandDeleteHandler(ctx) {
    ctx.session.tokens = [];
    await ctx.sendMessage("Token was deleted");
}

async function commandSettingsHandler(ctx) {
    if (ctx.update.message.from.username !== settings.adminUsername) {
        await ctx.sendMessage("You are not admin!");
        return;
    }
    await ctx.telegram.setMyCommands(COMMANDS);
    await ctx.sendMessage("Ok");
}

async function commandHelpHandler(ctx) {
    const text = COMMANDS.reduce(
        (accumulator, item) => `${accumulator}${item.command} - ${item.description}\n`,
        "Here are commands I understand:\n",
    );
    await ctx.sendMessage(text);
}

async function hearsTokenHandler(ctx) {
    // presumably token was passed
    const token = ctx.message.text;
    if (hasToken(ctx)) {
        if (token === ctx.session.tokens[0].token) {
            await ctx.sendMessage("The same token is already stored", {
                reply_to_message_id: ctx.message.message_id,
            });
            return;
        }
    }
    // noinspection ES6MissingAwait
    ctx.telegram.sendChatAction(ctx.chat.id, "typing");
    const togglUser = await TogglTrackAPI.me(token);
    if (!togglUser) {
        await ctx.sendMessage(
            "Seems like incorrect token...",
            {reply_to_message_id: ctx.message.message_id},
        );
        return;
    }
    // noinspection JSUnresolvedReference
    const tokenObj = {
        token: token,
        username: togglUser.fullname,
    };
    ctx.session.tokens = [tokenObj];
    const checkNowReplyMarkup = Markup.inlineKeyboard([
        Markup.button.callback("Check timer now", "check"),
    ]);
    await ctx.sendMessage(`Valid token for "${tokenObj.username}" is saved`, checkNowReplyMarkup);
}

async function actionCheckHandler(ctx) {
    ctx.answerCbQuery("Checking...");
    await ctx.editMessageReplyMarkup();
    await commandCheckHandler(ctx);
}

async function actionStartCheckingHandler(ctx) {
    const message = ctx.update.callback_query.message;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const tokenObj = ctx.session.tokens[0];
    if (tokenObj.checking) {
        await ctx.editMessageReplyMarkup(stopCheckingReplyMarkup.reply_markup);
        await ctx.answerCbQuery("Continue checking is active!\n" + "I will inform when the timer stops");
        return;
    }
    const currentTimer = await TogglTrackAPI.currentTimer(tokenObj.token);
    if (!currentTimer) {
        await ctx.editMessageText("Timer is already stopped", checkAgainReplyMarkup);
        return;
    }
    tokenObj.checking = true;
    tokenObj.lastDuration = currentTimer.duration;
    let msg = buildTimerMessage(tokenObj);
    await ctx.editMessageText(msg, stopCheckingReplyMarkup);
    const interval = humanDuration(settings.checkInterval);
    await ctx.answerCbQuery(`I will check every ${interval} and inform when the timer stops`);
    checkTimerStatusSetTimeout(ctx.sessionId, tokenObj.token);
}

async function actionStopCheckingHandler(ctx) {
    const tokenObj = ctx.session.tokens[0];
    if (!tokenObj.checking) {
        await ctx.editMessageText("Continuous checking is not active!", checkAgainReplyMarkup);
        return;
    }
    delete tokenObj.checking;
    await ctx.editMessageText("Continuous checking was stopped", checkAgainReplyMarkup);
}

async function actionUnknownHandler(ctx) {
    await ctx.editMessageReplyMarkup();
    await ctx.answerCbQuery("Unknown action");
}

async function onUnknownHandler(ctx) {
    await ctx.sendMessage("Unknown command, use /help");
}

async function onEditedMessageHandler(ctx) {
    await ctx.sendMessage("Editing messages is not supported");
}

async function catchErrorHandler(err, ctx) {
    let msg = ("Something went wrong...\n" + "Try again later");
    if (settings.adminUsername) {
        msg += "\n";
        msg += `Or let admin know about it: @${settings.adminUsername}`;
    }
    try {
        if (ctx.update.callback_query) {
            await ctx.answerCbQuery(msg, {show_alert: true});
        } else {
            await ctx.sendMessage(msg);
        }
    } catch (e) {
        console.error("Telegram error", e);
    }
    if (settings.debug) {
        throw err;
    }
    console.error("bot.catch", err);
}

const COMMANDS = [
    {
        command: "/start",
        description: "Start bot",
    },
    {
        command: "/check",
        description: "Check timer for the stored token",
    },
    {
        command: "/stop",
        description: "Stop current check",
    },
    {
        command: "/edit",
        description: "How to edit a token?",
    },
    {
        command: "/delete",
        description: "Delete my token from the storage",
    },
];

const bot = new Telegraf(settings.botToken);

bot.use(localSession.middleware());
bot.use(setup);

bot.command("start", commandStartHandler);
bot.command("edit", commandEditHandler);
bot.command("check", checkHasToken, commandCheckHandler);
bot.command("stop", checkHasToken, commandStopHandler);
bot.command("delete", checkHasToken, commandDeleteHandler);
bot.command("help", commandHelpHandler);
bot.command("settings", commandSettingsHandler);

bot.hears(/^[0-9a-f]{32}$/, hearsTokenHandler);

bot.action("check", checkHasToken, actionCheckHandler);
bot.action("start_checking", checkHasToken, actionStartCheckingHandler);
bot.action("stop_checking", checkHasToken, actionStopCheckingHandler);
bot.action(/.*/, actionUnknownHandler);

bot.on(message(), onUnknownHandler);
bot.on(editedMessage(), onEditedMessageHandler);

bot.catch(catchErrorHandler);

// noinspection JSIgnoredPromiseFromCall
bot.launch({
    allowedUpdates: ["message", "edited_message", "callback_query"],
});

// Enable graceful stop
function gracefullyStop(signal) {
    return function () {
        timeouts.forEach(clearTimeout);
        bot.stop(signal);
    };
}

for (const signal of ["SIGINT", "SIGQUIT", "SIGTERM"]) {
    process.once(signal, gracefullyStop(signal));
}
