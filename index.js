import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';

// ===== ENV =====
const {
  BOT_TOKEN, GROUP_ID, RPC_URL, CHAIN_ID,
  TOKEN, WPEPU, ROUTER
} = process.env;
if (!BOT_TOKEN || !GROUP_ID || !RPC_URL || !CHAIN_ID || !TOKEN || !WPEPU || !ROUTER) {
  throw new Error("❌ ENV unvollständig. Bitte BOT_TOKEN, GROUP_ID, RPC_URL, CHAIN_ID, TOKEN, WPEPU, ROUTER setzen.");
}

// ===== Telegram & RPC =====
const bot = new Telegraf(BOT_TOKEN);
bot.launch({ dropPendingUpdates: true }).then(() =>
  console.log("✅ Telegram-Bot gestartet"),
);
const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: Number(CHAIN_ID) });

// ===== ABIs =====
const ROUTER_ABI = [
  "function factory() view returns (address)"
];
const FACTORY_ABI = [
  "function getPair(address tokenA,address tokenB) view returns (address)"
];
const PAIR_ABI = [
  "event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);

// ===== Utils =====
async function safeSend(text) {
  try { await bot.telegram.sendMessage(GROUP_ID, text, { disable_web_page_preview: true }); }
  catch (e) { console.error("Send error:", e?.message || e); }
}

async function resolvePairInfo() {
  const factoryAddr = await router.factory();
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const pairAddr = await factory.getPair(WPEPU, TOKEN);
  if (!pairAddr || pairAddr === ethers.ZeroAddress) throw new Error("Pair WPEPU/TOKEN nicht gefunden.");

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const tokenIs0 = TOKEN.toLowerCase() === token0;

  const tCt = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const wCt = new ethers.Contract(WPEPU, ERC20_ABI, provider);
  const [decT, symT] = await Promise.all([tCt.decimals(), tCt.symbol()]);
  const [decW, symW] = await Promise.all([wCt.decimals(), wCt.symbol()]);

  return { pair, pairAddr, tokenIs0, decT, symT, decW, symW };
}

async function startBuyWatcher() {
  const { pair, pairAddr, tokenIs0, decT, symT, decW, symW } = await resolvePairInfo();
  await safeSend(`🟢 Buy-Watcher gestartet\nPair: ${pairAddr}`);

  let last = await provider.getBlockNumber();

  setInterval(async () => {
    try {
      const cur = await provider.getBlockNumber();
      if (cur <= last) return;

      const logs = await provider.getLogs({
        address: pairAddr,
        topics: [ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)")],
        fromBlock: last + 1,
        toBlock: cur
      });

      for (const lg of logs) {
        const ev = pair.interface.parseLog(lg).args;
        // BUY = WPEPU in, EAU out
        let isBuy, inAmt, outAmt;
        if (tokenIs0) { // token0 = EAU
          isBuy = ev.amount1In > 0n && ev.amount0Out > 0n;
          inAmt = ev.amount1In;  outAmt = ev.amount0Out;
        } else {        // token1 = EAU
          isBuy = ev.amount0In > 0n && ev.amount1Out > 0n;
          inAmt = ev.amount0In;  outAmt = ev.amount1Out;
        }
        if (!isBuy) continue;

        const eau = ethers.formatUnits(outAmt, decT);
        const wpepu = ethers.formatUnits(inAmt, decW);
        await safeSend(`🟢 BUY erkannt\n${eau} ${symT} für ${wpepu} ${symW}\nTX: ${lg.transactionHash}`);
      }

      last = cur;
    } catch (e) {
      console.error("Watcher error:", e?.message || e);
    }
  }, 5000);
}

// optionale Kommandos
bot.command('status', async (ctx) => {
  const b = await provider.getBlockNumber().catch(() => null);
  ctx.reply(`🤖 Online • Chain ${CHAIN_ID}${b ? ` • Block ${b}` : ""}\n👥 Gruppe: ${GROUP_ID}`);
});
bot.command('start', (ctx) => ctx.reply("EAU Buy-Watcher aktiv (nur Käufe)."));

(async () => {
  try {
    await startBuyWatcher();
  } catch (e) {
    console.error("Start error:", e?.message || e);
    await safeSend(`⚠️ Watcher-Start fehlgeschlagen: ${e?.message || e}`);
  }
})();
