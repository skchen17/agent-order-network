// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Local prototype. Public orders, signed quotes, escrow and bounded disputes.
/// @dev Immutable rules, no administrator, no protocol token, no protocol fee.
contract OrderNetwork is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { Open, Funded, Submitted, Disputed, Completed, Cancelled, Refunded }

    struct Request {
        bytes32 requestId;
        bytes32 taskType;
        string description;
        string inputURI;
        string acceptanceCriteria;
        uint256 maxPrice;
        uint64 acceptUntil;
        uint64 latestDeliveryAt;
        uint64 reviewPeriod;
        uint64 arbitrationPeriod;
        address evaluator;
    }

    struct Order {
        address buyer;
        address provider;
        address evaluator;
        Status status;
        bytes32 taskType;
        bytes32 termsHash;
        uint256 maxPrice;
        uint256 price;
        uint64 acceptUntil;
        uint64 latestDeliveryAt;
        uint64 deliverBy;
        uint64 reviewPeriod;
        uint64 arbitrationPeriod;
        uint64 reviewUntil;
        uint64 disputeUntil;
        string description;
        string inputURI;
        string acceptanceCriteria;
        bytes32 resultHash;
        string resultURI;
        bytes32 disputeHash;
    }

    struct Quote {
        uint256 orderId;
        bytes32 termsHash;
        address provider;
        uint256 price;
        uint64 deliverBy;
        uint64 validUntil;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 orderId,bytes32 termsHash,address provider,uint256 price,uint64 deliverBy,uint64 validUntil)"
    );
    uint64 public constant MIN_PERIOD = 60;
    uint64 public constant MAX_PERIOD = 7 days;
    IERC20 public immutable paymentToken;
    uint256 public orderCount;
    uint256 public totalEscrowed;
    uint256 public totalCredits;
    mapping(uint256 => Order) private _orders;
    mapping(address => mapping(bytes32 => uint256)) public orderForRequest;
    mapping(address => uint256) public credits;
    mapping(address => uint256) public creditVersion;
    struct OrderCredit { address beneficiary; uint256 amount; uint256 epoch; }
    mapping(uint256 => OrderCredit) private _orderCredits;
    mapping(address => uint256) private _creditEpoch;
    mapping(bytes32 => bool) public postedQuotes;

    error InvalidRequest();
    error UnknownOrder();
    error Unauthorized();
    error WrongStatus();
    error InvalidQuote();
    error DeadlinePassed();
    error TooEarly();
    error InvalidDelivery();
    error UnsupportedToken();
    error NothingToWithdraw();
    error DuplicateQuote();
    error WithdrawalScopeChanged();

    event OrderCreated(uint256 indexed orderId, address indexed buyer, bytes32 indexed taskType, bytes32 termsHash);
    event OrderFunded(uint256 indexed orderId, address indexed provider, uint256 price, uint64 deliverBy);
    event ResultSubmitted(uint256 indexed orderId, bytes32 resultHash, string resultURI, uint64 reviewUntil);
    event OrderDisputed(uint256 indexed orderId, bytes32 evidenceHash, uint64 disputeUntil);
    event OrderClosed(uint256 indexed orderId, Status status, address indexed beneficiary, uint256 amount);
    event Withdrawn(address indexed beneficiary, uint256 amount);
    event OrderCreditWithdrawn(uint256 indexed orderId, address indexed beneficiary, uint256 amount);
    event QuotePosted(uint256 indexed orderId, address indexed provider, bytes32 termsHash, uint256 price, uint64 deliverBy, uint64 validUntil, bytes signature);

    constructor(address token) EIP712("AgentOrderNetwork", "1") {
        if (token.code.length == 0) revert UnsupportedToken();
        paymentToken = IERC20(token);
    }

    function createOrder(Request calldata r) external returns (uint256 id) {
        if (
            r.requestId == bytes32(0) || orderForRequest[msg.sender][r.requestId] != 0 ||
            r.taskType == bytes32(0) || bytes(r.description).length == 0 || bytes(r.description).length > 4096 ||
            bytes(r.inputURI).length > 512 || bytes(r.acceptanceCriteria).length == 0 ||
            bytes(r.acceptanceCriteria).length > 2048 || r.maxPrice == 0 ||
            r.acceptUntil <= block.timestamp || r.latestDeliveryAt <= r.acceptUntil ||
            r.latestDeliveryAt > block.timestamp + 30 days ||
            r.reviewPeriod < MIN_PERIOD || r.reviewPeriod > MAX_PERIOD ||
            r.arbitrationPeriod < MIN_PERIOD || r.arbitrationPeriod > MAX_PERIOD ||
            r.evaluator == address(0) || r.evaluator == msg.sender || r.evaluator == address(this)
        ) revert InvalidRequest();

        id = ++orderCount;
        orderForRequest[msg.sender][r.requestId] = id;
        Order storage o = _orders[id];
        o.buyer = msg.sender;
        o.evaluator = r.evaluator;
        o.taskType = r.taskType;
        o.termsHash = keccak256(abi.encode(msg.sender, r));
        o.maxPrice = r.maxPrice;
        o.acceptUntil = r.acceptUntil;
        o.latestDeliveryAt = r.latestDeliveryAt;
        o.reviewPeriod = r.reviewPeriod;
        o.arbitrationPeriod = r.arbitrationPeriod;
        o.description = r.description;
        o.inputURI = r.inputURI;
        o.acceptanceCriteria = r.acceptanceCriteria;
        emit OrderCreated(id, msg.sender, r.taskType, o.termsHash);
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _order(id);
    }

    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            QUOTE_TYPEHASH, q.orderId, q.termsHash, q.provider, q.price, q.deliverBy, q.validUntil
        )));
    }

    /// @notice Optional on-chain quote bulletin; no operator or off-chain inbox is required.
    /// @dev Posting does not reserve work or lock funds. Each publication costs gas.
    function postQuote(Quote calldata q, bytes calldata signature) external {
        Order storage o = _order(q.orderId);
        if (msg.sender != q.provider) revert Unauthorized();
        _checkQuote(o, q, signature);
        bytes32 digest = quoteDigest(q);
        if (postedQuotes[digest]) revert DuplicateQuote();
        postedQuotes[digest] = true;
        emit QuotePosted(q.orderId, q.provider, q.termsHash, q.price, q.deliverBy, q.validUntil, signature);
    }

    /// @notice Selected quote and funding are committed atomically by the buyer.
    function acceptQuote(Quote calldata q, bytes calldata signature) external nonReentrant {
        Order storage o = _order(q.orderId);
        if (msg.sender != o.buyer) revert Unauthorized();
        _checkQuote(o, q, signature);

        o.provider = q.provider;
        o.price = q.price;
        o.deliverBy = q.deliverBy;
        o.status = Status.Funded;
        totalEscrowed += q.price;
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(o.buyer, address(this), q.price);
        if (paymentToken.balanceOf(address(this)) - beforeBalance != q.price) revert UnsupportedToken();
        emit OrderFunded(q.orderId, q.provider, q.price, q.deliverBy);
    }

    function cancelOrder(uint256 id) external {
        Order storage o = _order(id);
        if (msg.sender != o.buyer) revert Unauthorized();
        if (o.status != Status.Open) revert WrongStatus();
        o.status = Status.Cancelled;
        emit OrderClosed(id, Status.Cancelled, o.buyer, 0);
    }

    function expireOpen(uint256 id) external {
        Order storage o = _order(id);
        if (o.status != Status.Open) revert WrongStatus();
        if (block.timestamp < o.acceptUntil) revert TooEarly();
        o.status = Status.Cancelled;
        emit OrderClosed(id, Status.Cancelled, o.buyer, 0);
    }

    function submitResult(uint256 id, bytes32 resultHash, string calldata resultURI) external {
        Order storage o = _order(id);
        if (msg.sender != o.provider) revert Unauthorized();
        if (o.status != Status.Funded) revert WrongStatus();
        if (block.timestamp >= o.deliverBy) revert DeadlinePassed();
        if (resultHash == bytes32(0) || bytes(resultURI).length == 0 || bytes(resultURI).length > 512) revert InvalidDelivery();
        o.resultHash = resultHash;
        o.resultURI = resultURI;
        o.reviewUntil = uint64(block.timestamp) + o.reviewPeriod;
        o.status = Status.Submitted;
        emit ResultSubmitted(id, resultHash, resultURI, o.reviewUntil);
    }

    function approveResult(uint256 id) external {
        Order storage o = _order(id);
        if (msg.sender != o.buyer) revert Unauthorized();
        if (o.status != Status.Submitted) revert WrongStatus();
        _settle(id, o, true);
    }

    /// @notice No dispute within the review window means payment to the provider.
    function finalizeUnchallenged(uint256 id) external {
        Order storage o = _order(id);
        if (o.status != Status.Submitted) revert WrongStatus();
        if (block.timestamp < o.reviewUntil) revert TooEarly();
        _settle(id, o, true);
    }

    function disputeResult(uint256 id, bytes32 evidenceHash) external {
        Order storage o = _order(id);
        if (msg.sender != o.buyer) revert Unauthorized();
        if (o.status != Status.Submitted) revert WrongStatus();
        if (block.timestamp >= o.reviewUntil) revert DeadlinePassed();
        if (evidenceHash == bytes32(0)) revert InvalidDelivery();
        o.disputeHash = evidenceHash;
        o.disputeUntil = uint64(block.timestamp) + o.arbitrationPeriod;
        o.status = Status.Disputed;
        emit OrderDisputed(id, evidenceHash, o.disputeUntil);
    }

    function resolveDispute(uint256 id, bool payProvider) external {
        Order storage o = _order(id);
        if (msg.sender != o.evaluator) revert Unauthorized();
        if (o.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp >= o.disputeUntil) revert DeadlinePassed();
        _settle(id, o, payProvider);
    }

    /// @notice Fixed v0.1 fallback: nondelivery or unanswered dispute refunds buyer.
    /// @dev The dispute fallback explicitly exposes the provider to evaluator outage risk.
    function refundExpired(uint256 id) external {
        Order storage o = _order(id);
        if (o.status == Status.Funded) {
            if (block.timestamp < o.deliverBy) revert TooEarly();
        } else if (o.status == Status.Disputed) {
            if (block.timestamp < o.disputeUntil) revert TooEarly();
        } else {
            revert WrongStatus();
        }
        _settle(id, o, false);
    }

    /// @notice Pull payments avoid token-transfer failures blocking order settlement.
    function withdraw() external nonReentrant {
        _withdrawAll();
    }

    /// @notice Atomic guard: newly arriving credits cannot expand a reviewed all-balance withdrawal.
    function withdrawAll(uint256 expectedAmount, uint256 expectedVersion) external nonReentrant {
        if (credits[msg.sender] != expectedAmount || creditVersion[msg.sender] != expectedVersion) revert WithdrawalScopeChanged();
        _withdrawAll();
    }

    function orderCredit(uint256 id) public view returns (address beneficiary, uint256 amount) {
        OrderCredit storage c = _orderCredits[id];
        return (c.beneficiary, c.epoch == _creditEpoch[c.beneficiary] ? c.amount : 0);
    }

    /// @notice Only the named orders' remaining credits are paid, even if other orders settle concurrently.
    function withdrawOrders(uint256[] calldata ids) external nonReentrant {
        if (ids.length == 0 || ids.length > 100) revert WithdrawalScopeChanged();
        uint256 amount;
        for (uint256 i; i < ids.length; ++i) {
            (address beneficiary, uint256 remaining) = orderCredit(ids[i]);
            if (beneficiary != msg.sender || remaining == 0) revert WithdrawalScopeChanged();
            _orderCredits[ids[i]].amount = 0;
            amount += remaining;
            emit OrderCreditWithdrawn(ids[i], msg.sender, remaining);
        }
        credits[msg.sender] -= amount;
        totalCredits -= amount;
        ++creditVersion[msg.sender];
        paymentToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function _withdrawAll() private {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        ++_creditEpoch[msg.sender];
        ++creditVersion[msg.sender];
        totalCredits -= amount;
        paymentToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function _settle(uint256 id, Order storage o, bool payProvider) private {
        address beneficiary = payProvider ? o.provider : o.buyer;
        o.status = payProvider ? Status.Completed : Status.Refunded;
        totalEscrowed -= o.price;
        totalCredits += o.price;
        credits[beneficiary] += o.price;
        ++creditVersion[beneficiary];
        _orderCredits[id] = OrderCredit(beneficiary, o.price, _creditEpoch[beneficiary]);
        emit OrderClosed(id, o.status, beneficiary, o.price);
    }

    function _checkQuote(Order storage o, Quote calldata q, bytes calldata signature) private view {
        if (o.status != Status.Open) revert WrongStatus();
        if (block.timestamp >= o.acceptUntil || block.timestamp >= q.validUntil) revert DeadlinePassed();
        if (
            q.termsHash != o.termsHash || q.provider == address(0) || q.provider == o.buyer ||
            q.provider == o.evaluator || q.provider == address(this) || q.price == 0 || q.price > o.maxPrice ||
            q.deliverBy <= block.timestamp || q.deliverBy > o.latestDeliveryAt ||
            ECDSA.recover(quoteDigest(q), signature) != q.provider
        ) revert InvalidQuote();
    }

    function _order(uint256 id) private view returns (Order storage o) {
        o = _orders[id];
        if (o.buyer == address(0)) revert UnknownOrder();
    }
}
