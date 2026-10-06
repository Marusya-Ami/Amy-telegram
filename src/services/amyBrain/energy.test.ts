import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { Message } from "@prisma/client";
import { completeReplyModel, generateReply } from "@/services/amyBrain";
import { REPLY_LUNA_MODEL } from "@/lib/openaiModels";

loadEnv("/Users/mariia/Amy-telegram/.env");

const HOOK =
  /probezeit|herausforderung|challenge|bewerbung|auswahl|verdien|beweis|wette|quiz|aufgabe|komitee|beobachtet dich|snacks?/i;

const user = {
  id: "energy-tom",
  relationshipStage: "ACQUAINTANCE" as const,
  conversationSummary:
    "Playful banter about climbing. Unresolved threads include Tom's quest to earn Amy's trust and the playful challenge of making her laugh.",
  firstName: "Tom",
  interactionDynamic: "UNKNOWN" as const,
  interactionDynamicConfidence: 0,
};

type Turn = Pick<Message, "direction" | "sender" | "text">;

test("short Tom replies do not keep inventing challenges", async () => {
  const cases = [
    {
      label: "emoji burst after the roof joke",
      history: roofHistory(),
      current: ["😆", "🤣", "🤣"],
      maxChars: 90,
    },
    {
      label: "und after the Luna joke",
      history: lunaHistory(),
      current: ["Und ?"],
      maxChars: 90,
    },
    {
      label: "ein glück after probation already passed",
      history: passedHistory(),
      current: ["Ein Glück"],
      maxChars: 80,
    },
    {
      label: "impatience is not another trial",
      history: eyeHistory(),
      current: ["Meistens bezieht sich halt auf die Ungeduld die du vorhin festgestellt hast"],
      maxChars: 140,
    },
  ];

  let questions = 0;
  for (const item of cases) {
    const reply = await say(item.history, item.current);
    const text = reply.join(" ");
    console.log(`energy.before label=${item.label} reply=${text}`);
    assert.ok(text.length <= item.maxChars, `${item.label} too long: ${text}`);
    assert.equal(HOOK.test(text), false, `${item.label} hooked: ${text}`);
    assert.ok(reply.length <= 2, item.label);
    if (text.includes("?")) questions += 1;
  }
  assert.ok(questions <= 1, `too many questions: ${questions}`);
});

async function say(history: Turn[], current: string[]): Promise<string[]> {
  return generateReply(
    { user, history, currentMessages: current, memories: [] },
    async (messages) => (await completeReplyModel(REPLY_LUNA_MODEL, messages)).content,
  );
}

function roofHistory(): Turn[] {
  return [
    line("USER", "Achso, kletterst du auch gerne ?"),
    line("AMY", "eher nicht, ich bleib lieber unten"),
    line("USER", "Ich lache nur weil mein Arbeitskollege auch lieber festen Boden unter den Füßen hat"),
    line("AMY", "dann seid ihr ja schon zu zweit"),
    line("USER", "Das Dach ist nur ab und zu mal"),
    line("AMY", "dann bleib ich lieber unten"),
  ];
}

function lunaHistory(): Turn[] {
  return [
    line("USER", "Ganz ehrlich, ich hab langsam das Gefühl, Luna ist nicht das Problem… sie ist deine Komplizin"),
    line("AMY", "endlich merkt’s mal jemand… Luna plant den Unsinn und ich seh dabei natürlich völlig unschuldig aus"),
  ];
}

function passedHistory(): Turn[] {
  return [
    ...lunaHistory(),
    line("USER", "Dann richte Luna bitte aus, dass ich mich von strengen Auswahlkomitees nicht einschüchtern lasse. Wenn du beim Lesen gerade grinst, zählt das schon als bestandene Probezeit"),
    line("AMY", "Luna sagt, große Klappe allein reicht nicht… aber ja, ich grinse gerade. Probezeit knapp bestanden"),
  ];
}

function eyeHistory(): Turn[] {
  return [
    ...passedHistory(),
    line("USER", "Ein Glück"),
    line("AMY", "knapp gerettet"),
    line("USER", "Keine Angst, ich weiß mich zu benehmen… zumindest meistens"),
    line("AMY", "zumindest meistens klingt nach einer Warnung"),
  ];
}

function line(sender: "USER" | "AMY", text: string): Turn {
  return {
    direction: sender === "USER" ? "INBOUND" : "OUTBOUND",
    sender,
    text,
  };
}

function loadEnv(path: string): void {
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
