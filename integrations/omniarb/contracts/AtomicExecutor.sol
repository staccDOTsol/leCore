// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IAtomicToken {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address account, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IOmniRouterV2 {
    function buy(address token, address hook, uint256 minAmountOut, address recipient, uint256 deadline)
        external payable returns (uint256);
    function sell(
        address token, address hook, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline
    ) external payable returns (uint256);
}

/// @notice Restricted native -> token -> native round trip through one verified router.
/// @dev No curve calls, arbitrary targets, token inventory spending, or persistent approvals.
contract AtomicExecutor {
    address public immutable owner;
    address public immutable router;
    address public immutable token;
    address public immutable hook;
    uint256 private entered;

    error Unauthorized();
    error Reentrancy();
    error InvalidConfiguration();
    error InvalidTrade();
    error Expired();
    error TokenOperationFailed();
    error InventoryChanged();
    error TooLittleOutput();
    error Unprofitable(uint256 received, uint256 required);
    error NativeTransferFailed();

    constructor(address owner_, address router_, address token_, address hook_) {
        if (owner_ == address(0) || router_.code.length == 0 || token_.code.length == 0
            || hook_ == address(0) || hook_.code.length == 0) revert InvalidConfiguration();
        owner = owner_;
        router = router_;
        token = token_;
        hook = hook_;
    }

    function execute(
        bool buyHooked,
        uint256 minTokensOut,
        uint256 minNativeOut,
        uint256 minProfit,
        uint256 deadline
    ) external payable returns (uint256 nativeOut) {
        if (msg.sender != owner) revert Unauthorized();
        if (entered != 0) revert Reentrancy();
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0 || minTokensOut == 0 || minNativeOut == 0 || minProfit == 0) revert InvalidTrade();
        entered = 1;
        uint256 nativeBefore = address(this).balance - msg.value;
        uint256 tokensBefore = IAtomicToken(token).balanceOf(address(this));
        _approve(0);

        IOmniRouterV2(router).buy{value: msg.value}(
            token, buyHooked ? hook : address(0), minTokensOut, address(this), deadline
        );
        uint256 boughtBalance = IAtomicToken(token).balanceOf(address(this));
        if (boughtBalance < tokensBefore) revert InventoryChanged();
        uint256 bought = boughtBalance - tokensBefore;
        if (bought < minTokensOut) revert TooLittleOutput();
        _approve(bought);
        IOmniRouterV2(router).sell(
            token, buyHooked ? address(0) : hook, bought, minNativeOut, address(this), deadline
        );
        _approve(0);
        if (IAtomicToken(token).balanceOf(address(this)) != tokensBefore) revert InventoryChanged();
        if (address(this).balance < nativeBefore) revert InventoryChanged();
        nativeOut = address(this).balance - nativeBefore;
        if (nativeOut < minNativeOut) revert TooLittleOutput();
        if (nativeOut < msg.value + minProfit) revert Unprofitable(nativeOut, msg.value + minProfit);

        (bool sent,) = owner.call{value: nativeOut}("");
        if (!sent) revert NativeTransferFailed();
        if (address(this).balance != nativeBefore || IAtomicToken(token).balanceOf(address(this)) != tokensBefore)
            revert InventoryChanged();
        entered = 0;
    }

    function _approve(uint256 amount) private {
        (bool ok, bytes memory result) =
            token.call(abi.encodeCall(IAtomicToken.approve, (router, amount)));
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))
            || IAtomicToken(token).allowance(address(this), router) != amount) revert TokenOperationFailed();
    }

    receive() external payable {
        if (msg.sender != router || entered == 0) revert Unauthorized();
    }
}
