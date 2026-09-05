/**
 * dustsweep.xyz -- Robinhood Chain (4663) address book
 * Block 1 recon, verified on-chain 2026-09-04 @ block ~54,430,170.
 *
 * VERIFIED = read directly off mainnet (eth_getCode / eth_call / logs).
 * REPORTED = from third-party docs, not yet confirmed on-chain.
 */

export const CHAIN_ID = 4663;
export const RPC_PUBLIC = 'https://rpc.mainnet.chain.robinhood.com'; // rate-limited
export const EXPLORER = 'https://robinhoodchain.blockscout.com';

/** VERIFIED */
export const TOKENS = {
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // 18 dec, aeWETH proxy
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // 6 dec, "Global Dollar"
} as const;

/** VERIFIED -- SwapRouter02 confirmed 3 independent ways. See tech reference. */
export const UNISWAP_V3 = {
  factory:         '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  swapRouter02:    '0xcaf681a66d020601342297493863e78c959e5cb2',
  quoterV2:        '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  tickLens:        '0x7dfd4f31be6814d2906bde155c3e1b146eac1468',
  multicall:       '0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3',
  permit2:         '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const;

/**
 * DO NOT route v3 swaps through this. It is the Robinhood-modified
 * UniversalRouter -- its v4 swap struct carries an extra minHopPriceX36
 * field and stock SDK calldata reverts. Listed for completeness only.
 */
export const UNIVERSAL_ROUTER_V4_ONLY = '0x8876789976decbfcbbbe364623c63652db8c0904';

/**
 * VERIFIED. Noxa is the largest dust source on the chain: ~63,000 tokens,
 * ~75% of all deployments, halted 11 Jul 2026, front end gone.
 * Its getDexConfig(0) is byte-identical to Pons V1's, so the SAME
 * V3Adapter path handles both. Index both factories, hardcode neither.
 */
export const NOXA_FACTORY = '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB';

/**
 * Shared by BOTH Noxa and Pons V1 -- identical topic0 hashes.
 * Index these from both factory addresses to enumerate sweepable tokens.
 */
export const TOPIC_TOKEN_DEPLOYED =
  '0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a';
export const TOPIC_TOKEN_LAUNCHED =
  '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

/** VERIFIED */
export const PONS = {
  v1Factory:     '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB', // launches DISABLED, tokens still live
  v2Factory:     '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  v2LaunchAndBuy:'0xe33e9e479df8802cb0866d5d05258bec4cf62948', // atomic dev buy, NOT a trading router
  v2MemeHook:    '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
} as const;

/**
 * Noxa and Pons V1 both LAUNCH at the 1% tier, WETH-paired.
 * 148/148 Pons V1 and 50/50 Noxa sampled launches confirm this.
 * BUT pools can be opened at other tiers afterwards -- CASHCAT has
 * 10000 (1023 WETH), 3000 (827 WETH) and 500 (0.11 WETH).
 * Quote all three and take the best. 10000 first, it is where launch
 * liquidity lives.
 */
export const LAUNCH_POOL = { pairToken: TOKENS.WETH, fee: 10000, tickSpacing: 200 } as const;
export const FEE_TIERS = [10000, 3000, 500] as const;

/** VERIFIED. All V2 curves share identical bytecode, so one ABI fits all. */
export const PONS_V2_CURVE_ABI = [
  'function sell(uint256 tokenAmountIn, uint256 minQuoteOut, address recipient)',
  'function buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable',
  'function getReserves() view returns (uint256, uint256)',
  'function tokenReserve() view returns (uint256)',
  'function quoteReserve() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function token() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function currentSnipeTaxBps(address) view returns (uint256)',
  'function maxInternalPriceImpactBps() view returns (uint256)',
] as const;

export const SELECTORS = {
  curveSell: '0xd04c6983', // sell(uint256,uint256,address)
  curveBuy:  '0x59a87bc1', // buy(uint256,uint256,address)
} as const;

/** topic0 of PonsV2LaunchFactory.TokenLaunched(token, curve, deployer, ...) */
export const TOPIC_V2_TOKEN_LAUNCHED =
  '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';

/**
 * VERIFIED on-chain. 3,991 tokens (allTokensLength), ~6% of Noxa's size,
 * so this is the SECOND adapter, not the first. Sells in native ETH,
 * unlike Pons V2. BagsLens.getTokenStates(address[]) is a batch state
 * read, which makes the three-pile sort cheap here.
 */
export const BAGS = {
  factory:         '0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37',
  lens:            '0xC82Db941dAf90B754aecb5F7D14c683dc608d595',
  v4Hook:          '0x2380aBf72C17aABAb76480244759AC7E2932EEcC',
  vault:           '0x4861446aa7fFd9e67a83cBbAcb1A4B70540B83Aa',
  v4Quoter:        '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  stateView:       '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  poolManager:     '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  multicall3:      '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const;

export const BAGS_SELECTORS = {
  curveForToken:    '0x8580756c',
  feeShareForToken: '0x2df10da5',
  allTokensLength:  '0xdbb80e42',
  allTokens:        '0x634282af',
  getTokens:        '0x494cfc6c',
  getTokenState:    '0x0b3eb970', // BagsLens
  getTokenStates:   '0xc393c774', // BagsLens, BATCH -- use this
} as const;

/**
 * Permit2 batch signature transfer: one signature, many tokens.
 * This is what the sweeper's single-signature flow depends on.
 * Verified present on the canonical Permit2 deployment.
 */
export const PERMIT2_BATCH_TRANSFER_SELECTOR = '0xedd9444b';

/**
 * aeWETH implementation exposes standard withdraw()/deposit(),
 * so SwapRouter02.unwrapWETH9 works. Verified.
 */
export const WETH_IMPL = '0xc6b81b429797e0f555440b70cd99e032d7ae947e';

/* ------------------------------------------------------------------ *
 * OURS. Everything above this line is a fact about Robinhood Chain and
 * was read off the chain. Everything below it is a contract we deployed,
 * so it is empty until `script/Deploy.s.sol` has run and it is wrong the
 * moment you redeploy.
 * ------------------------------------------------------------------ */

/**
 * The mainnet Sweeper. Commit this one when the real deploy happens.
 * Leave it empty until then: an address here that is not live is worse
 * than none, because the failure is a revert at signing time rather than
 * a message at load time.
 */
const SWEEPER_DEPLOYED: string = '';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Local fork override, same shape as VITE_RPC_URL:
 *
 *   VITE_SWEEPER=0x... VITE_RPC_URL=http://127.0.0.1:8545 npm run dev
 *
 * anvil hands out a fresh Sweeper address every time you restart it and
 * redeploy, so this is an env var rather than an edit to a tracked file.
 *
 * Unlike RHC_RPC_URL this is safe in the bundle. A deployed contract
 * address is public by construction. That is not true of the Alchemy
 * key, which is Foundry-only and must never appear under app/.
 */
const sweeperRaw = import.meta.env.VITE_SWEEPER?.trim() || SWEEPER_DEPLOYED;

export const SWEEPER: `0x${string}` | null =
  ADDR_RE.test(sweeperRaw) ? (sweeperRaw as `0x${string}`) : null;

/** True when the Sweeper came from the env override, i.e. a local fork. */
export const SWEEPER_IS_OVERRIDDEN =
  SWEEPER !== null && sweeperRaw !== SWEEPER_DEPLOYED;

/**
 * The write half calls this. Do not read SWEEPER directly on a
 * transaction path: a missing address there means a Permit2 batch signed
 * with a spender of nobody, which spends the user's approvals for
 * nothing and is unrecoverable in a funnel where almost no one returns.
 */
export function requireSweeper(): `0x${string}` {
  if (SWEEPER === null) {
    throw new Error(
      'No Sweeper address. Run script/Deploy.s.sol, then set VITE_SWEEPER ' +
        'for a local fork or fill in SWEEPER_DEPLOYED in ' +
        'app/src/lib/addresses.ts. See docs/LOCAL-TESTING.md.',
    );
  }
  return SWEEPER;
}
