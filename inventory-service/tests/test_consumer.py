"""Unit tests for Kafka consumer supervision with exponential backoff."""
import asyncio

import pytest
from unittest.mock import AsyncMock, patch

from app.kafka.consumer import (
    run_consumer_supervised,
    _BACKOFF_INITIAL,
    _BACKOFF_FACTOR,
    _BACKOFF_MAX,
)


class TestConsumerSupervision:
    """Tests for run_consumer_supervised() restart and backoff behavior."""

    @pytest.mark.asyncio
    async def test_restarts_after_exception_with_backoff(self):
        """Consumer restarts after a non-cancellation exception."""
        call_count = 0

        async def mock_consumer_loop():
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                raise RuntimeError("Kafka connection lost")
            # Third call: cancel to stop the loop
            raise asyncio.CancelledError()

        with (
            patch("app.kafka.consumer._run_consumer_loop", side_effect=mock_consumer_loop),
            patch("app.kafka.consumer.asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
        ):
            with pytest.raises(asyncio.CancelledError):
                await run_consumer_supervised()

            assert call_count == 3
            # Two exceptions before CancelledError -> two sleeps
            assert mock_sleep.call_count == 2
            # First backoff = _BACKOFF_INITIAL (1.0)
            mock_sleep.assert_any_call(_BACKOFF_INITIAL)

    @pytest.mark.asyncio
    async def test_cancelled_error_propagates_no_restart(self):
        """CancelledError is re-raised immediately without restart."""
        async def mock_consumer_loop():
            raise asyncio.CancelledError()

        with (
            patch("app.kafka.consumer._run_consumer_loop", side_effect=mock_consumer_loop),
            patch("app.kafka.consumer.asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
        ):
            with pytest.raises(asyncio.CancelledError):
                await run_consumer_supervised()

            # No backoff sleep should happen for CancelledError
            mock_sleep.assert_not_called()

    @pytest.mark.asyncio
    async def test_backoff_increases_exponentially(self):
        """Backoff doubles on each consecutive failure up to max."""
        call_count = 0

        async def mock_consumer_loop():
            nonlocal call_count
            call_count += 1
            if call_count <= 4:
                raise RuntimeError("Kafka down")
            raise asyncio.CancelledError()

        with (
            patch("app.kafka.consumer._run_consumer_loop", side_effect=mock_consumer_loop),
            patch("app.kafka.consumer.asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
        ):
            with pytest.raises(asyncio.CancelledError):
                await run_consumer_supervised()

            # 4 exceptions -> 4 sleeps
            assert mock_sleep.call_count == 4
            sleep_args = [call.args[0] for call in mock_sleep.call_args_list]

            expected_backoffs = [
                _BACKOFF_INITIAL,                                           # 1.0
                _BACKOFF_INITIAL * _BACKOFF_FACTOR,                         # 2.0
                _BACKOFF_INITIAL * _BACKOFF_FACTOR ** 2,                    # 4.0
                _BACKOFF_INITIAL * _BACKOFF_FACTOR ** 3,                    # 8.0
            ]
            assert sleep_args == expected_backoffs

    @pytest.mark.asyncio
    async def test_backoff_capped_at_max(self):
        """Backoff never exceeds _BACKOFF_MAX (60s)."""
        call_count = 0
        # Need enough iterations to exceed max backoff
        # 1, 2, 4, 8, 16, 32, 64->60, 64->60
        max_calls = 8

        async def mock_consumer_loop():
            nonlocal call_count
            call_count += 1
            if call_count <= max_calls:
                raise RuntimeError("Kafka down")
            raise asyncio.CancelledError()

        with (
            patch("app.kafka.consumer._run_consumer_loop", side_effect=mock_consumer_loop),
            patch("app.kafka.consumer.asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
        ):
            with pytest.raises(asyncio.CancelledError):
                await run_consumer_supervised()

            sleep_args = [call.args[0] for call in mock_sleep.call_args_list]
            # All backoff values must be <= _BACKOFF_MAX
            for val in sleep_args:
                assert val <= _BACKOFF_MAX

            # The last few should be exactly _BACKOFF_MAX
            assert sleep_args[-1] == _BACKOFF_MAX

    @pytest.mark.asyncio
    async def test_backoff_resets_after_successful_start(self):
        """Backoff resets to initial after a normal (non-exception) consumer exit."""
        call_count = 0

        async def mock_consumer_loop():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("Kafka error")
            if call_count == 2:
                raise RuntimeError("Kafka error again")
            if call_count == 3:
                # Normal exit (no exception) -> backoff resets
                return
            if call_count == 4:
                raise RuntimeError("Kafka error after reset")
            raise asyncio.CancelledError()

        with (
            patch("app.kafka.consumer._run_consumer_loop", side_effect=mock_consumer_loop),
            patch("app.kafka.consumer.asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
        ):
            with pytest.raises(asyncio.CancelledError):
                await run_consumer_supervised()

            sleep_args = [call.args[0] for call in mock_sleep.call_args_list]
            # call 1: error -> sleep(1.0)
            # call 2: error -> sleep(2.0)
            # call 3: normal exit -> backoff resets (no sleep for normal exit)
            # call 4: error -> sleep(1.0) (reset!)
            # call 5: CancelledError -> no sleep
            assert sleep_args == [1.0, 2.0, 1.0]
