import { BigInt, BigDecimal, Address, Bytes, store } from '@graphprotocol/graph-ts';
import {
  Deposited,
  Withdrawn,
  AddLiquidityCall,
  RemoveLiquidityCall,
  NewPoolCall,
  //SetPoolControllerCall,
  BatchSwapGivenInCall,
  BatchSwapGivenOutCall,
  TokenSwap,
} from '../types/Vault/Vault';
import { Balancer, Pool, PoolToken, Swap, TokenPrice, User, PoolTokenizer } from '../types/schema';
import {
  hexToDecimal,
  tokenToDecimal,
  getPoolTokenId,
  createPoolShareEntity,
  createPoolTokenEntity,
  updatePoolLiquidity,
  ZERO_BD,
  decrPoolCount,
} from './helpers';

export function handleNewPool(call: NewPoolCall): void {
  let vault = Balancer.load('2');

  // if no vault yet, set up blank initial
  if (vault == null) {
    vault = new Balancer('2');
    vault.color = 'Silver';
    vault.poolCount = 0;
    vault.finalizedPoolCount = 0;
    vault.txCount = BigInt.fromI32(0);
    vault.totalLiquidity = ZERO_BD;
    vault.totalSwapVolume = ZERO_BD;
    vault.totalSwapFee = ZERO_BD;
  }

  const poolId = call.outputs.value0;
  const pool = new Pool(poolId.toHexString());
  pool.controller = call.from;
  pool.active = true;
  // TODO
  pool.swapFee = BigDecimal.fromString('0.000001');
  pool.totalWeight = ZERO_BD;
  pool.totalSwapVolume = ZERO_BD;
  pool.totalSwapFee = ZERO_BD;
  pool.liquidity = ZERO_BD;
  pool.tokenized = true;
  pool.createTime = call.block.timestamp.toI32();
  pool.tokensCount = BigInt.fromI32(0);
  pool.swapsCount = BigInt.fromI32(0);
  pool.controller = call.from;
  pool.vaultID = '2';
  pool.tokensList = [];
  pool.tx = call.transaction.hash;
  pool.save();

  vault.poolCount = vault.poolCount + 1;
  vault.save();

  const poolTokenizer = new PoolTokenizer(call.from.toHexString());
  poolTokenizer.poolId = poolId.toHexString();
  poolTokenizer.totalShares = ZERO_BD;
  poolTokenizer.holdersCount = BigInt.fromI32(0);
  poolTokenizer.joinsCount = BigInt.fromI32(0);
  poolTokenizer.exitsCount = BigInt.fromI32(0);
  poolTokenizer.save();
}

export function handleAddLiquidity(call: AddLiquidityCall): void {
  const poolId = call.inputs.poolId.toHex();

  const pool = Pool.load(poolId);
  const tokensList = pool.tokensList || [];

  const poolTokenizer = PoolTokenizer.load(pool.controller.toHex());

  poolTokenizer.joinsCount = poolTokenizer.joinsCount.plus(BigInt.fromI32(1));
  const tokenAddresses = call.inputs.tokens;
  const amounts = call.inputs.amounts;
  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    const tokenAddress = tokenAddresses[i];
    const poolTokenId = getPoolTokenId(poolId, tokenAddress);
    let poolToken = PoolToken.load(poolTokenId);

    // adding initial liquidity
    if (poolToken == null) {
      if (tokensList.indexOf(tokenAddress) == -1) {
        tokensList.push(tokenAddress);
      }
      createPoolTokenEntity(poolId, tokenAddress);
      poolToken = PoolToken.load(poolTokenId);
    }

    const tokenAmountIn = tokenToDecimal(amounts[i].toBigDecimal(), poolToken.decimals);
    const newAmount = poolToken.balance.plus(tokenAmountIn);
    poolToken.balance = newAmount;
    poolToken.save();
  }
  pool.tokensList = tokensList;
  pool.save();

  poolTokenizer.save();
  updatePoolLiquidity(poolId);
}

export function handleRemoveLiquidity(call: RemoveLiquidityCall): void {
  const poolId = call.inputs.poolId.toHex();
  const pool = Pool.load(poolId);

  const poolTokenizer = PoolTokenizer.load(pool.controller.toHex());

  poolTokenizer.joinsCount = poolTokenizer.joinsCount.plus(BigInt.fromI32(1));

  const tokenAddresses = call.inputs.tokens;
  const amounts = call.inputs.amounts;
  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    const tokenAddress = tokenAddresses[i];
    const poolTokenId = getPoolTokenId(poolId, tokenAddress);
    const poolToken = PoolToken.load(poolTokenId);

    const tokenAmountOut = tokenToDecimal(amounts[i].toBigDecimal(), poolToken.decimals);
    const newAmount = poolToken.balance.minus(tokenAmountOut);
    poolToken.balance = newAmount;
    poolToken.save();
  }

  poolTokenizer.save();
  updatePoolLiquidity(poolId);
}

export function handleUserBalanceDeposited(event: Deposited): void {
  let user = User.load(event.params.user.toString());
  if (user == null) {
    user = new User(event.params.user.toString());
    user.save();
  }
}

export function handleUserBalanceWithdrawn(event: Withdrawn): void {
  let user = User.load(event.params.user.toString());
  if (user == null) {
    user = new User(event.params.user.toString());
    user.save();
  }
}

//export function handleSetPoolController(call: SetPoolControllerCall): void {
//const poolId = call.inputs.poolId;
//const controller = call.inputs.controller;
//const pool = Pool.load(poolId.toHex());

//pool.controller = controller;
//pool.save();
//}

/************************************
 ************** SWAPS ***************
 ************************************/
export function handleSwapEvent(event: TokenSwap): void {
  const poolId = event.params.poolId;
  const tokenDeltas = event.params.tokenDeltas;
  const pool = Pool.load(poolId.toHexString());
  const tokensList: Bytes[] = pool.tokensList;

  for (let i: i32 = 0; i < tokensList.length; i++) {
    const tokenAddressBytes: Bytes = tokensList[i32(i)];
    const tokenAddress: Address = Address.fromString(tokenAddressBytes.toHexString());

    const poolTokenId = getPoolTokenId(poolId.toHexString(), tokenAddress);
    const poolToken = PoolToken.load(poolTokenId);

    poolToken.balance = poolToken.balance.plus(new BigDecimal(tokenDeltas[i]));
  }
}

export function handleBatchSwapGivenIn(call: BatchSwapGivenInCall): void {
  const swaps = call.inputs.swaps;
  const tokens = call.inputs.tokens;
  const funds = call.inputs.funds;

  for (let i: i32 = 0; i < swaps.length; i++) {
    //struct SwapInternal {
    //bytes32 poolId;
    //uint128 tokenInIndex;
    //uint128 tokenOutIndex;
    //uint128 amount; // amountIn, amountOut
    //bytes userData;
    //}
    const swapStruct = swaps[i];
    const poolId = swapStruct.poolId;
    const tokenInAddress = tokens[i32(swapStruct.tokenInIndex)];
    const tokenOutAddress = tokens[i32(swapStruct.tokenOutIndex)];
    const amountIn = swapStruct.amountIn;

    const swapId = call.transaction.hash.toHexString().concat(i.toString());

    const poolTokenIdIn = getPoolTokenId(poolId.toHexString(), tokenInAddress);
    const poolTokenIn = PoolToken.load(poolTokenIdIn);

    const poolTokenIdOut = getPoolTokenId(poolId.toHexString(), tokenOutAddress);
    const poolTokenOut = PoolToken.load(poolTokenIdOut);

    const swap = new Swap(swapId);
    swap.caller = call.from; // TODO
    swap.tokenIn = tokenInAddress;
    swap.tokenInSym = poolTokenIn.symbol;
    swap.tokenOut = tokenOutAddress;
    swap.tokenOutSym = poolTokenOut.symbol;
    swap.userAddress = call.from.toHex();
    swap.poolId = poolId.toHex();
    swap.value = BigDecimal.fromString('100'); //TODO
    swap.feeValue = BigDecimal.fromString('1'); //TODO
    swap.protocolFeeValue = BigDecimal.fromString('0'); //TODO
    swap.poolTotalSwapVolume = BigDecimal.fromString('0'); //TODO
    swap.poolTotalSwapFee = BigDecimal.fromString('0'); //TODO
    swap.poolLiquidity = BigDecimal.fromString('1000'); //TODO
    swap.timestamp = call.block.timestamp.toI32();
    swap.save();

    const pool = Pool.load(poolId.toHex());
    pool.swapsCount = pool.swapsCount + BigInt.fromI32(1);
    pool.save();
  }
}

export function handleBatchSwapGivenOut(call: BatchSwapGivenOutCall): void {
  const swaps = call.inputs.swaps;
  const tokens = call.inputs.tokens;
  const funds = call.inputs.funds;

  for (let i: i32 = 0; i < swaps.length; i++) {
    //struct SwapInternal {
    //bytes32 poolId;
    //uint128 tokenInIndex;
    //uint128 tokenOutIndex;
    //uint128 amount; // amountIn, amountOut
    //bytes userData;
    //}
    const swapStruct = swaps[i];
    const poolId = swapStruct.poolId;
    const tokenInAddress = tokens[i32(swapStruct.tokenInIndex)];
    const tokenOutAddress = tokens[i32(swapStruct.tokenOutIndex)];
    const amountOut = swapStruct.amountOut;

    const swapId = call.transaction.hash.toHexString().concat(i.toString());

    const poolTokenIdIn = getPoolTokenId(poolId.toHexString(), tokenInAddress);
    const poolTokenIn = PoolToken.load(poolTokenIdIn);

    const poolTokenIdOut = getPoolTokenId(poolId.toHexString(), tokenOutAddress);
    const poolTokenOut = PoolToken.load(poolTokenIdOut);

    const swap = new Swap(swapId);
    swap.caller = call.from; // TODO
    swap.tokenIn = tokenInAddress;
    swap.tokenInSym = poolTokenIn.symbol;
    swap.tokenOut = tokenOutAddress;
    swap.tokenOutSym = poolTokenOut.symbol;
    swap.userAddress = call.from.toHex();
    swap.poolId = poolId.toHex();
    swap.value = BigDecimal.fromString('100'); //TODO
    swap.feeValue = BigDecimal.fromString('1'); //TODO
    swap.protocolFeeValue = BigDecimal.fromString('0'); //TODO
    swap.poolTotalSwapVolume = BigDecimal.fromString('0'); //TODO
    swap.poolTotalSwapFee = BigDecimal.fromString('0'); //TODO
    swap.poolLiquidity = BigDecimal.fromString('1000'); //TODO
    swap.timestamp = call.block.timestamp.toI32();
    swap.save();

    const pool = Pool.load(poolId.toHex());
    pool.swapsCount = pool.swapsCount + BigInt.fromI32(1);
    pool.save();
  }
}

//const swapId = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString());
//let swap = Swap.load(swapId);
//if (swap == null) {
//swap = new Swap(swapId);
//}

//const pool = Pool.load(poolId);
//const tokensList: Array<Bytes> = pool.tokensList;
//let tokenOutPriceValue = ZERO_BD;
//const tokenOutPrice = TokenPrice.load(tokenOut);

//if (tokenOutPrice != null) {
//tokenOutPriceValue = tokenOutPrice.price;
//} else {
//for (let i: i32 = 0; i < tokensList.length; i++) {
//const tokenPriceId = tokensList[i].toHexString();
//if (!tokenOutPriceValue.gt(ZERO_BD) && tokenPriceId !== tokenOut) {
//const tokenPrice = TokenPrice.load(tokenPriceId);
//if (tokenPrice !== null && tokenPrice.price.gt(ZERO_BD)) {
//const poolTokenId = poolId.concat('-').concat(tokenPriceId);
//let poolToken = PoolToken.load(poolTokenId);
//tokenOutPriceValue = tokenPrice.price // TODO incorrect
//.times(poolToken.balance)
////.div(poolToken.denormWeight)
////.times(poolTokenOut.denormWeight)
//.div(poolTokenOut.balance);
//}
//}
//}
//}

//let totalSwapVolume = pool.totalSwapVolume;
//let totalSwapFee = pool.totalSwapFee;
//let liquidity = pool.liquidity;
//let swapValue = ZERO_BD;
//let swapFeeValue = ZERO_BD;

//if (tokenOutPriceValue.gt(ZERO_BD)) {
//swapValue = tokenOutPriceValue.times(tokenAmountOut);
//swapFeeValue = swapValue.times(pool.swapFee);
//totalSwapVolume = totalSwapVolume.plus(swapValue);
//totalSwapFee = totalSwapFee.plus(swapFeeValue);

//let factory = Balancer.load('1');
//factory.totalSwapVolume = factory.totalSwapVolume.plus(swapValue);
//factory.totalSwapFee = factory.totalSwapFee.plus(swapFeeValue);
//factory.save();

//pool.totalSwapVolume = totalSwapVolume;
//pool.totalSwapFee = totalSwapFee;
//}
//pool.swapsCount = pool.swapsCount + BigInt.fromI32(1);
//if (newAmountIn.equals(ZERO_BD) || newAmountOut.equals(ZERO_BD)) {
//decrPoolCount(true);
//pool.active = false;
//}
//pool.save();

//swap.caller = event.params.caller;
//swap.tokenIn = event.params.tokenIn;
//swap.tokenInSym = poolTokenIn.symbol;
//swap.tokenOut = event.params.tokenOut;
//swap.tokenOutSym = poolTokenOut.symbol;
//swap.tokenAmountIn = tokenAmountIn;
//swap.tokenAmountOut = tokenAmountOut;
//swap.poolAddress = event.address.toHex();
//swap.userAddress = event.transaction.from.toHex();
//swap.poolTotalSwapVolume = totalSwapVolume;
//swap.poolTotalSwapFee = totalSwapFee;
//swap.poolLiquidity = liquidity;
//swap.value = swapValue;
//swap.feeValue = swapFeeValue;
//swap.timestamp = event.block.timestamp.toI32();
//swap.save();
//}
