// noinspection SqlNoDataSourceInspection, ES6MissingAwait

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
console.assert(settings.botToken, "env.BOT_TOKEN is not set");
console.assert(settings.checkInterval >= 10, "env.CHECK_INTERVAL should be greater than 10");

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

function restoreTimerChecks(db) {
    const data = db.get("sessions").value();
    data.forEach((session) => {
        session.data.tokens.forEach((tokenObj) => {
            if (!tokenObj.checking) {
                return;
            }
            checkTimerStatus(session.id, tokenObj.token);
        });
    });
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
    return `${hours}${minutes}${seconds}ago`;
}

function hasToken(ctx) {
    return ctx.session.tokens.length;
}

function checkTimerStatus(sessionId, token) {
    const db = localSession.DB;
    const tokenObj = dbGetTokenObj(db, sessionId, token);
    if (!tokenObj?.checking) {
        return;
    }
    const currentTimer = TogglTrackAPI.currentTimer(token);
    if (currentTimer) {
        checkTimerStatusSetTimeout(sessionId, token);
        return;
    }
    delete tokenObj.checking;
    db.write();
    const reply_markup = Markup.inlineKeyboard([
        Markup.button.callback("Check again", "check"),
    ]);
    const chatId = sessionId.split(":")[0];
    bot.telegram.sendMessage(chatId, "Timer was stopped!", reply_markup);
}

function checkTimerStatusSetTimeout(sessionId, token) {
    setTimeout(() => {
        checkTimerStatus(sessionId, token);
    }, settings.checkInterval * 1000);
}

async function checkHasToken(ctx, next) {
    if (hasToken(ctx)) {
        return next();
    }
    const msg = "There's not stored token. Send it to the chat first";
    if (ctx.update.callback_query) {
        ctx.answerCbQuery(msg, {show_alert: true});
    } else {
        ctx.reply(msg);
    }
}

async function myMiddleware(ctx, next) {
    const title = `Processing update ${ctx.update.update_id}`;
    console.time(title);
    if (ctx.chat.type === "private") {
        initSession(ctx.session);
        ctx.sessionId = localSession.getSessionKey(ctx);
        if (settings.debug) {
            console.debug("chat:", ctx.chat);
            console.debug("update:", ctx.update);
            console.debug("session:", ctx.session);
        }
        await next();
    } else {
        // noinspection ES6MissingAwait
        ctx.reply("Incorrect chat type");
    }
    console.timeEnd(title);
}

async function commandCheckHandler(ctx) {
    const tokenObj = ctx.session.tokens[0];
    const currentTimer = await TogglTrackAPI.currentTimer(tokenObj.token);
    if (!currentTimer) {
        ctx.reply("Timer is not started");
        return;
    }
    tokenObj.lastDuration = currentTimer.duration;

    const now = Math.floor(Date.now() / 1000);
    const duration = humanDuration(now + currentTimer.duration); // duration - negative unix timestamp
    let reply_markup;
    let msg = `Timer was started ${duration}`;
    if (tokenObj.checking) {
        msg += "\n";
        msg += "Continuous checking is active";
        reply_markup = Markup.inlineKeyboard([
            Markup.button.callback("Stop", "stop_checking"),
        ]);
    } else {
        reply_markup = Markup.inlineKeyboard([
            Markup.button.callback("Start checking regularly", "start_checking"),
        ]);
    }
    ctx.reply(msg, reply_markup);
}

async function commandStartHandler(ctx) {
    if (hasToken(ctx)) {
        const tokenObj = ctx.session.tokens[0];
        ctx.reply(
            `I have a token stored for "${tokenObj.username}".\n` +
            `But you can send me another one to replace it.\n` +
            `/check — to perform a timer check`,
        );
        return;
    }
    ctx.reply(
        "Send me a token.\n" +
        "You can find it here: https://track.toggl.com/profile#api-token",
    );
}

async function commandStopHandler(ctx) {
    const tokenObj = ctx.session.tokens[0];
    if (!tokenObj.checking) {
        ctx.reply("Continuous checking is not active!");
        return;
    }
    tokenObj.checking = false;
    ctx.reply("Continuous checking was stopped");
}

async function commandEditHandler(ctx) {
    ctx.reply("Simply send me a new token, I will replace the old one with it");
}

async function commandDeleteHandler(ctx) {
    ctx.session.tokens = [];
    ctx.reply("Token was deleted");
}

async function commandSettingsHandler(ctx) {
    if (ctx.update.from.username !== settings.adminUsername) {
        ctx.reply("You are not admin!");
        return;
    }
    await ctx.telegram.setMyCommands(COMMANDS);
    ctx.reply("Ok");
}

async function commandHelpHandler(ctx) {
    const text = COMMANDS.reduce(
        (accumulator, item) => `${accumulator}${item.command} - ${item.description}\n`,
        "Here are commands I understand:\n",
    );
    ctx.reply(text);
}

async function hearsTokenHandler(ctx) {
    // presumably token was passed
    const token = ctx.message.text;
    if (hasToken(ctx)) {
        if (token === ctx.session.tokens[0].token) {
            ctx.reply("The same token is already stored", {
                reply_to_message_id: ctx.message.message_id,
            });
            return;
        }
    }
    ctx.telegram.sendChatAction(ctx.chat.id, "typing");
    const togglUser = await TogglTrackAPI.me(token);
    if (!togglUser) {
        ctx.reply(
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
    const reply_markup = Markup.inlineKeyboard([
        Markup.button.callback("Check timer now", "check"),
    ]);
    ctx.reply(`Valid token for "${tokenObj.username}" is saved`, reply_markup);
}

async function actionCheckHandler(ctx) {
    ctx.editMessageReplyMarkup();
    ctx.answerCbQuery("Checking...");
    commandCheckHandler(ctx);
}

async function actionStartCheckingHandler(ctx) {
    const message = ctx.update.callback_query.message;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    ctx.editMessageReplyMarkup();
    const tokenObj = ctx.session.tokens[0];
    if (tokenObj.checking) {
        ctx.answerCbQuery(
            "Continue checking is active!\n" +
            "I will inform when the timer stops",
            {show_alert: true},
        );
        return;
    }
    const token = tokenObj.token;
    const currentTimer = await TogglTrackAPI.currentTimer(token);
    if (!currentTimer) {
        ctx.editMessageText(
            "Timer is already stopped",
            {message_id: messageId},
        );
        return;
    }
    tokenObj.checking = true;
    const duration = humanDuration(settings.checkInterval);
    ctx.answerCbQuery(`I will check every ${duration} and inform when the timer stops`);
    checkTimerStatusSetTimeout(ctx.sessionId, tokenObj.token);
}

async function actionStopCheckingHandler(ctx) {
    ctx.editMessageReplyMarkup();
    const tokenObj = ctx.session.tokens[0];
    if (!tokenObj.checking) {
        ctx.answerCbQuery(
            "Continuous checking is not active!",
            {show_alert: true},
        );
        return;
    }
    tokenObj.checking = false;
    ctx.answerCbQuery("Continuous checking was stopped");
}

async function onUnknownHandler(ctx) {
    ctx.reply("Unknown command, use /help");
}

async function onEditedMessageHandler(ctx) {
    ctx.reply("Editing messages is not supported");
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
            await ctx.reply(msg);
        }
    } catch (e) {
        console.error("Telegram error", e);
    }
    if (settings.debug) {
        throw err;
    }
    console.trace("bot.catch", err);
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
bot.use(myMiddleware);

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

bot.on(message(), onUnknownHandler);
bot.on(editedMessage(), onEditedMessageHandler);

bot.catch(catchErrorHandler);

bot.launch({
    allowedUpdates: ["message", "edited_message", "callback_query"],
});

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
if (!settings.debug) {
    process.on("uncaughtException", (err) => console.trace("uncaughtException", err));
}
