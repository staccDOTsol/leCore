// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal Uniswap-v4 swap helper + atomic two-venue arbitrage executor.
///
/// Why this exists: omnichain.family's own router only ever builds a PoolKey with
/// its own hook, so it cannot touch the hookless (`hooks == address(0)`) v4 pool that
/// exists at the same CA on every chain. Uniswap's UniversalRouter is not deployed on
/// Robinhood / World / Monad. This contract reaches every v4 pool on every chain.
///
/// Holds no state and no balances between calls: whatever a call produces is forwarded
/// to msg.sender in the same transaction, so it is safe to leave deployed.

type Currency is address;

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(Currency currency) external;
    function settle() external payable returns (uint256);
    function take(Currency currency, address to, uint256 amount) external;
}

interface IERC20 {
    function transfer(address to, uint256 v) external returns (bool);
    function approve(address s, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface IOmniRouter {
    function buy(address token, address hook, uint256 minAmountOut, address recipient, uint256 deadline)
        external
        payable
        returns (uint256);
    function sell(
        address token,
        address hook,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external payable returns (uint256);
}

contract OmniArb {
    uint160 internal constant MIN_SQRT = 4295128739;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;

    error NotManager();
    error Unprofitable(uint256 got, uint256 need);
    error TooLittleOut(uint256 got, uint256 need);
    error NativeSendFailed();

    /// transient: the manager we are currently unlocked by
    address private locker;

    struct SwapReq {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address payer;
    }

    // ---------------------------------------------------------------- v4 core

    function _v4SwapExactIn(IPoolManager pm, PoolKey memory key, bool zeroForOne, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        locker = address(pm);
        bytes memory res = pm.unlock(abi.encode(SwapReq(key, zeroForOne, amountIn, address(this))));
        locker = address(0);
        amountOut = abi.decode(res, (uint256));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != locker) revert NotManager();
        IPoolManager pm = IPoolManager(msg.sender);
        SwapReq memory r = abi.decode(raw, (SwapReq));

        int256 packed = pm.swap(
            r.key,
            SwapParams({
                zeroForOne: r.zeroForOne,
                amountSpecified: -int256(r.amountIn),
                sqrtPriceLimitX96: r.zeroForOne ? MIN_SQRT + 1 : MAX_SQRT - 1
            }),
            ""
        );

        int128 d0 = int128(packed >> 128);
        int128 d1 = int128(packed);

        Currency inC = r.zeroForOne ? r.key.currency0 : r.key.currency1;
        Currency outC = r.zeroForOne ? r.key.currency1 : r.key.currency0;
        int128 owed = r.zeroForOne ? d0 : d1;
        int128 gained = r.zeroForOne ? d1 : d0;

        uint256 payAmt = uint256(uint128(-owed));
        _settle(pm, inC, payAmt);

        uint256 outAmt = uint256(uint128(gained));
        pm.take(outC, address(this), outAmt);
        return abi.encode(outAmt);
    }

    function _settle(IPoolManager pm, Currency c, uint256 amt) internal {
        if (Currency.unwrap(c) == address(0)) {
            pm.settle{value: amt}();
        } else {
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(pm), amt);
            pm.settle();
        }
    }

    // ------------------------------------------------------------ public swap

    /// Swap exact-in through any v4 pool. Native in => send value; token in => approve first.
    function swapV4(IPoolManager pm, PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        payable
        returns (uint256 out)
    {
        Currency inC = zeroForOne ? key.currency0 : key.currency1;
        if (Currency.unwrap(inC) != address(0)) {
            _pull(Currency.unwrap(inC), amountIn);
        }
        out = _v4SwapExactIn(pm, key, zeroForOne, amountIn);
        if (out < minOut) revert TooLittleOut(out, minOut);
        _sweep(zeroForOne ? key.currency1 : key.currency0);
        _sweepNativeDust();
    }

    // ------------------------------------------------------------------- arb

    /// Buy `token` on omnichain.family's hooked pool, sell it into a raw v4 pool.
    /// Whole round trip is native -> token -> native and reverts unless it clears minProfit.
    function arbHookedToV4(
        IOmniRouter omniRouter,
        address token,
        address hook,
        IPoolManager pm,
        PoolKey calldata v4Key,
        uint256 minProfit
    ) external payable returns (uint256 profit) {
        uint256 start = msg.value;
        uint256 bought =
            omniRouter.buy{value: start}(token, hook, 0, address(this), block.timestamp);

        IERC20(token).approve(address(pm), type(uint256).max);
        // token is currency1 (native is currency0), so selling token = oneForZero
        uint256 back = _v4SwapExactIn(pm, v4Key, false, bought);

        if (back < start + minProfit) revert Unprofitable(back, start + minProfit);
        profit = back - start;
        _sendNative(msg.sender, address(this).balance);
    }

    /// Buy `token` on a raw v4 pool, sell it into omnichain.family's hooked pool.
    function arbV4ToHooked(
        IPoolManager pm,
        PoolKey calldata v4Key,
        IOmniRouter omniRouter,
        address token,
        address hook,
        uint256 minProfit
    ) external payable returns (uint256 profit) {
        uint256 start = msg.value;
        uint256 bought = _v4SwapExactIn(pm, v4Key, true, start);

        IERC20(token).approve(address(omniRouter), type(uint256).max);
        uint256 back = omniRouter.sell(token, hook, bought, 0, address(this), block.timestamp);

        if (back < start + minProfit) revert Unprofitable(back, start + minProfit);
        profit = back - start;
        _sendNative(msg.sender, address(this).balance);
    }

    // --------------------------------------------------------------- helpers

    function _pull(address token, uint256 amt) internal {
        (bool ok, bytes memory d) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amt)
        );
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "pull failed");
    }

    function _sweep(Currency c) internal {
        address a = Currency.unwrap(c);
        if (a == address(0)) return;
        uint256 b = IERC20(a).balanceOf(address(this));
        if (b > 0) IERC20(a).transfer(msg.sender, b);
    }

    function _sweepNativeDust() internal {
        uint256 b = address(this).balance;
        if (b > 0) _sendNative(msg.sender, b);
    }

    function _sendNative(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert NativeSendFailed();
    }

    /// Rescue anything that somehow lingers. Open on purpose: the contract is
    /// never meant to hold a balance between transactions.
    function sweepTo(address token, address to) external {
        if (token == address(0)) {
            _sendNative(to, address(this).balance);
        } else {
            IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
        }
    }

    receive() external payable {}
}
