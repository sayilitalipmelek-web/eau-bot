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

/* ========= Helper ========= */
async function safeSend(msg) {
  try {
    await bot.telegram.sendMessage(GROUP_ID, msg, { disable_web_page_preview: true });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

/* ========= Setup ========= */
async function resolvePair() {
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const factory = new ethers.Contract(await router.factory(), FACTORY_ABI, provider);

  const pairAddr = await factory.getPair(WPEPU, TOKEN);
  if (!pairAddr || pairAddr === ethers.ZeroAddress)
    throw new Error("⚠️ Pair nicht gefunden (TOKEN/WPEPU)");

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const tokenIs0 = TOKEN.toLowerCase() === token0;

  const tCt = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const wCt = new ethers.Contract(WPEPU, ERC20_ABI, provider);
  const [decT, symT] = await Promise.all([tCt.decimals(), tCt.symbol()]);
  const [decW, symW] = await Promise.all([wCt.decimals(), wCt.symbol()]);

  return { pair, pairAddr, tokenIs0, decT, symT, decW, symW };
}

/* ========= Watcher ========= */
async function startWatcher() {
  const net = await provider.getNetwork();
  console.log(`✅ Verbunden mit ${net.name} (${Number(net.chainId)})`);

  const { pair, pairAddr, tokenIs0, decT, symT, decW, symW } = await resolvePair();
  await safeSend(`🟢 **Buy-Watcher aktiv**\nPair: \`${pairAddr}\``);

  let lastBlock = await provider.getBlockNumber();

  setInterval(async () => {
    try {
      const current = await provider.getBlockNumber();
      if (current <= lastBlock) return;

      const logs = await provider.getLogs({
        address: pairAddr,
        topics: [ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)")],
        fromBlock: lastBlock + 1,
        toBlock: current
      });

      for (const log of logs) {
        let ev;
        try {
          ev = pair.interface.parseLog(log).args;
        } catch { continue; }

        let isBuy, inAmt, outAmt;
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
        } catch { continue; }

        if (!isBuy) continue;

        let eau = 0, wpepu = 0;
        try {
          eau = parseFloat(ethers.formatUnits(outAmt || 0n, decT || 18));
          wpepu = parseFloat(ethers.formatUnits(inAmt || 0n, decW || 18));
        } catch { continue; }

        if (!isFinite(eau) || !isFinite(wpepu) || eau <= 0 || wpepu <= 0) continue;

        await safeSend(
          `🟢 **BUY erkannt!**\n` +
          `${eau.toFixed(4)} ${symT} für ${wpepu.toFixed(4)} ${symW}\n` +
          `TX: \`${log.transactionHash}\``
        );
      }

      lastBlock = current;
    } catch (err) {
      console.error("Watcher error:", err.message);
    }
  }, 7000);
}

/* ========= Telegram ========= */
bot.start((ctx) => ctx.reply("EAU Cooling Bot läuft ✅ Zeigt nur Käufe."));
bot.command("status", async (ctx) => {
  const block = await provider.getBlockNumber().catch(() => 0);
  ctx.reply(`📡 Chain ${CHAIN_ID}\nBlock: ${block}\nNur Käufe werden angezeigt.`);
});

/* ========= Start ========= */
bot.launch({ dropPendingUpdates: true })
  .then(async () => {
    console.log("🤖 Bot gestartet...");
    await startWatcher().catch(async (e) => {
      console.error("Start error:", e.message);
      await safeSend(`⚠️ Fehler: ${e.message}`);
    });
  })
  .catch((e) => console.error("Bot launch error:", e.message));
