// index.js
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';

/* ========= ENV prüfen ========= */
const REQ = ["BOT_TOKEN","GROUP_ID","RPC_URL","CHAIN_ID","TOKEN","WPEPU","ROUTER"];
for (const k of REQ) if (!process.env[k]) throw new Error(`❌ ENV fehlt: ${k}`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID  = process.env.GROUP_ID;
const RPC_URL   = process.env.RPC_URL;
const CHAIN_ID  = Number(process.env.CHAIN_ID);
const TOKEN     = process.env.TOKEN;
const WPEPU     = process.env.WPEPU;
const ROUTER    = process.env.ROUTER;

/* ========= Telegram ========= */
const bot = new Telegraf(BOT_TOKEN);

/* ========= Provider ========= */
const provider = new ethers.JsonRpcProvider(RPC_URL, {
  name: "pepe-unchained",
  chainId: CHAIN_ID
});

/* ========= ABIs ========= */
const ROUTER_ABI  = [ "function factory() view returns (address)" ];
const FACTORY_ABI = [ "function getPair(address tokenA,address tokenB) view returns (address)" ];
const PAIR_ABI    = [
  "event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const ERC20_ABI   = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

/* ========= Helpers ========= */
async function safeSend(text) {
  try {
    await bot.telegram.sendMessage(GROUP_ID, text, { disable_web_page_preview: true });
  } catch (e) {
    console.error("Send error:", e?.message || e);
  }
}

const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);

/* ========= LP-Pair auflösen ========= */
async function resolvePairInfo() {
  const factoryAddr = await router.factory();
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);

  const pairAddr = await factory.getPair(WPEPU, TOKEN);
  if (!pairAddr || pairAddr === ethers.ZeroAddress) {
    throw new Error("Pair WPEPU/EAU nicht gefunden – Prüfe ENV oder ob LP existiert.");
  }

  const pair   = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const tokenIs0 = TOKEN.toLowerCase() === token0;

  const tCt = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const wCt = new ethers.Contract(WPEPU, ERC20_ABI, provider);
  const [decT, symT] = await Promise.all([tCt.decimals(), tCt.symbol()]);
  const [decW, symW] = await Promise.all([wCt.decimals(), wCt.symbol()]);

  return { pair, pairAddr, tokenIs0, decT, symT, decW, symW };
}

/* ========= Watcher ========= */
async function startBuyWatcher() {
  const net = await provider.getNetwork();
  console.log(`✅ Verbunden: ${net.name} (chainId ${Number(net.chainId)})`);

  const { pair, pairAddr, tokenIs0, decT, symT, decW, symW } = await resolvePairInfo();
  await safeSend(`🟢 Buy-Watcher gestartet\nPair: \`${pairAddr}\``);

  let last = await provider.getBlockNumber();

  setInterval(async () => {
    try {
      const current = await provider.getBlockNumber();
      if (current <= last) return;

      const logs = await provider.getLogs({
        address: pairAddr,
        topics: [ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)")],
        fromBlock: last + 1,
        toBlock: current
      });

      for (const lg of logs) {
        let ev;
        try {
          ev = pair.interface.parseLog(lg).args;
        } catch {
          continue;
        }

        let isBuy = false;
        let inAmt = 0n;
        let outAmt = 0n;

        try {
          if (tokenIs0) {
            isBuy = ev.amount1In > 0n && ev.amount0Out > 0n;
            inAmt = ev.amount1In;
            outAmt = ev.amount0Out;
          } else {
            isBuy = ev.amount0In > 0n && ev.amount1Out > 0n;
            inAmt = ev.amount0In;
            outAmt = ev.amount1Out;
          }
        } catch {
          continue;
        }

        if (!isBuy) continue;

        let eau = 0;
        let wpepu = 0;
        try {
          eau = parseFloat(ethers.formatUnits(outAmt || 0n, decT || 18));
          wpepu = parseFloat(ethers.formatUnits(inAmt || 0n, decW || 18));
        } catch {
          continue;
        }

        // Wenn ein Wert NaN oder unplausibel ist → skippen
        if (!isFinite(eau) || !isFinite(wpepu) || eau <= 0 || wpepu <= 0) continue;

        await safeSend(
          `🟢 **BUY erkannt!**\n` +
          `${eau.toFixed(4)} ${symT} für ${wpepu.toFixed(4)} ${symW}\n` +
          `TX: \`${lg.transactionHash}\``
        );
      }

      last = current;
    } catch (e) {
      console.error("Watcher error:", e?.message || e);
    }
  }, 6000);
}

/* ========= Telegram Commands ========= */
bot.command('status', async (ctx) => {
  const b = await provider.getBlockNumber().catch(() => null);
  ctx.reply(
    `🤖 Online | Chain ${CHAIN_ID} | ${b ? `Block ${b}` : 'kein Block'}\n` +
    `Token: ${TOKEN}\nÜberwacht nur Käufe (WPEPU → EAU)`
  );
});

bot.start((ctx)=> ctx.reply("EAU Buy-Watcher aktiv ✅ (meldet nur Käufe aus WPEPU → EAU)."));

/* ========= Start ========= */
bot.launch({ dropPendingUpdates: true })
  .then(async () => {
    console.log("✅ Telegram-Bot gestartet");
    await startBuyWatcher().catch(async e => {
      console.error("Startfehler:", e?.message || e);
      await safeSend(`⚠️ Startfehler: ${e?.message || e}`);
    });
  })
  .catch(e => console.error("Bot launch error:", e?.message || e));
