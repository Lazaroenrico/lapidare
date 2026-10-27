import pytest

from learnharness.core.schema_gate import SUPPORTED_SCHEMA_VERSION, SchemaTooNew, check_schema


def test_accepts_equal_and_older():
    check_schema(2, 2)
    check_schema(1, 2)


def test_refuses_newer():
    with pytest.raises(SchemaTooNew, match="schema 3"):
        check_schema(3, 2)


def test_default_matches_config_contract():
    from learnharness.core.contracts.config import HarnessConfig

    assert HarnessConfig().schema_version == SUPPORTED_SCHEMA_VERSION
    with pytest.raises(SchemaTooNew):
        check_schema(SUPPORTED_SCHEMA_VERSION + 1)
