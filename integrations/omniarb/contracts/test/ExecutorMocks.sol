// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../AtomicExecutor.sol";

contract TestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public approvalMode;

    function setApprovalMode(uint256 mode) external { approvalMode = mode; }
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        if (approvalMode == 1) return false;
        require(amount == 0 || allowance[msg.sender][spender] == 0, "reset required");
        allowance[msg.sender][spender] = amount;
        if (approvalMode == 2) assembly { return(0, 0) }
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract TestHook {}

contract TestRouter {
    uint256 public payout = 12;
    bool public callbackBlocked;
    bool public callback;
    address public buyHook;
    address public sellHook;
    uint256 public sold;

    function configure(uint256 payout_, bool callback_) external {
        payout = payout_;
        callback = callback_;
    }
    function buy(address token, address hook, uint256, address recipient, uint256)
        external payable returns (uint256)
    {
        buyHook = hook;
        if (callback) {
            (bool ok,) = msg.sender.call(abi.encodeCall(AtomicExecutor.execute, (true, 1, 1, 1, block.timestamp)));
            callbackBlocked = !ok;
        }
        TestToken(token).mint(recipient, 10);
        return type(uint256).max; // The executor must measure balances, not trust this return.
    }
    function sell(address token, address hook, uint256 amount, uint256, address recipient, uint256)
        external payable returns (uint256)
    {
        sellHook = hook;
        sold = amount;
        TestToken(token).transferFrom(msg.sender, address(this), amount);
        (bool ok,) = recipient.call{value: payout}("");
        require(ok);
        return type(uint256).max;
    }
    receive() external payable {}
}

contract TestOwner {
    AtomicExecutor public executor;
    bool public callback;
    bool public rejectNative;
    bool public callbackBlocked;

    function setExecutor(AtomicExecutor executor_) external { executor = executor_; }
    function configure(bool callback_, bool rejectNative_) external {
        callback = callback_;
        rejectNative = rejectNative_;
    }
    function run(bool buyHooked, uint256 minProfit, uint256 deadline) external payable returns (uint256) {
        return executor.execute{value: msg.value}(buyHooked, 1, 1, minProfit, deadline);
    }
    receive() external payable {
        require(!rejectNative);
        if (callback) {
            (bool ok,) = address(executor).call{value: 1}(
                abi.encodeCall(AtomicExecutor.execute, (true, 1, 1, 1, block.timestamp))
            );
            callbackBlocked = !ok;
        }
    }
}
