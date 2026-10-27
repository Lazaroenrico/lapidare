"""A checkpoint database written by the pinned langgraph-checkpoint-sqlite must stay readable.

Regenerate ``fixtures/langgraph-v3.1.2.sqlite`` only on a deliberate bump of the langgraph
packages (see uv.lock): if this test fails after a bump, existing users' Vaults break.
"""

import shutil
from pathlib import Path

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

FIXTURE = Path(__file__).parent.parent / "fixtures" / "langgraph-v3.1.2.sqlite"


async def test_current_saver_reads_the_pinned_fixture(tmp_path):
    database = tmp_path / "langgraph.sqlite"
    shutil.copy(FIXTURE, database)  # the saver may write (WAL), so never open the fixture itself
    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        found = await saver.aget_tuple({"configurable": {"thread_id": "compat-thread"}})
    assert found is not None
    assert found.checkpoint["channel_values"] == {"topic": "compat"}
    assert found.metadata is not None and found.metadata["source"] == "input"
