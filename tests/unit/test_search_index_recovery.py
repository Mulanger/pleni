from decimal import Decimal

from scripts.recover_search_index import recovery_should_continue


def test_recovery_respects_time_work_and_reserved_cost() -> None:
    bounds = dict(
        elapsed_s=10.0,
        deadline_s=100,
        completed=20,
        max_clips=100,
        tokens=100_000,
        price=Decimal("0.13"),
        max_usd=Decimal("1"),
    )
    assert recovery_should_continue(**bounds)
    assert not recovery_should_continue(**{**bounds, "elapsed_s": 100.0})
    assert not recovery_should_continue(**{**bounds, "completed": 100})
    assert not recovery_should_continue(**{**bounds, "max_usd": Decimal("0.01")})
