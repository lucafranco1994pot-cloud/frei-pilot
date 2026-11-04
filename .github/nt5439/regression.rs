
// NT-5439: a foreign client's open order that reuses our numeric order ID must not
// accept or update our still-active local order
async fn nt5439_feed_open_order(order_id: i32, client_id: i32, perm_id: i64, order_ref: &str) -> (usize, bool) {
    let client_order_id = ClientOrderId::from("O-NT5439-LOCAL");
    let equity = equity_aapl();
    let instrument_id = equity.id();
    let orders = OrderTracker::new(NATIVE_CLIENT_ID);
    let instrument_provider = create_test_instrument_provider();
    let (exec_sender, mut exec_receiver) = tokio::sync::mpsc::unbounded_channel();
    let commission_cache = Arc::new(Mutex::new(CommissionCache::new()));
    let pending_execution_cache = Arc::new(Mutex::new(PendingExecutionCache::new()));
    let position_tracker = create_position_tracker();

    instrument_provider.insert_test_instrument(InstrumentAny::from(equity), 12345, 1);
    let mut tracked = create_tracked_order_context(client_order_id, instrument_id);
    tracked.accepted = false;
    tracked.perm_id = 5_439_001;
    insert_tracked_order(&orders, order_id, tracked);

    let mut open_order = create_test_open_order(order_id, "Submitted", order_ref);
    open_order.order.client_id = client_id;
    open_order.order.perm_id = perm_id;
    open_order.order.total_quantity = 1.0;
    open_order.order.order_type = "LMT".to_string();
    open_order.order.limit_price = Some(100.0);

    // The result is ignored on purpose: a later error must not hide an emitted acceptance
    let _ = InteractiveBrokersExecutionClient::handle_order_update(
        &OrderUpdate::OpenOrder(open_order),
        &orders,
        &instrument_provider,
        &exec_sender.clone().into(),
        nautilus_core::time::get_atomic_clock_realtime(),
        AccountId::from("IB-001"),
        Ustr::from("001"),
        &commission_cache,
        &pending_execution_cache,
        &position_tracker,
        None,
    )
    .await;

    let mut accepted = 0;
    while let Ok(event) = exec_receiver.try_recv() {
        if matches!(event, ExecutionEvent::Order(OrderEventAny::Accepted(_))) {
            accepted += 1;
        }
    }
    let local_accepted = orders
        .lock()
        .unwrap()
        .active_orders
        .get(&order_id)
        .is_some_and(|order| order.accepted);
    (accepted, local_accepted)
}

#[rstest]
#[case("")]
#[case("O-NT5439-FOREIGN")]
#[tokio::test]
async fn nt5439_foreign_open_order_does_not_accept_local_order(#[case] foreign_order_ref: &str) {
    let (accepted, local_accepted) =
        nt5439_feed_open_order(7, NATIVE_CLIENT_ID + 1, 5_439_002, foreign_order_ref).await;
    assert!(
        accepted == 0 && !local_accepted,
        "NT5439: foreign OpenOrder emitted OrderAccepted (events={accepted}, local_accepted={local_accepted})"
    );
}

#[rstest]
#[case("")]
#[case("O-NT5439-LOCAL")]
#[tokio::test]
async fn nt5439_control_own_open_order_is_still_accepted(#[case] order_ref: &str) {
    let (accepted, local_accepted) =
        nt5439_feed_open_order(7, NATIVE_CLIENT_ID, 5_439_001, order_ref).await;
    assert!(
        accepted == 1 && local_accepted,
        "NT5439 control: own OpenOrder was not accepted (events={accepted}, local_accepted={local_accepted})"
    );
}
