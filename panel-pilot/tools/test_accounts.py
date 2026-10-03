import tempfile
import unittest
from pathlib import Path

from accounts import AccountError, AccountStore


class AccountStoreTests(unittest.TestCase):
    def test_existing_owner_credentials_are_preserved_without_new_account_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AccountStore(Path(directory) / "accounts.sqlite3")
            owner = store.ensure_owner("reader@example.test", "legacy")
            self.assertTrue(owner["isAdmin"])
            self.assertEqual(owner["username"], "reader@example.test")
            self.assertEqual(store.authenticate("reader@example.test", "legacy")["id"], owner["id"])

    def test_owner_and_books_only_account_are_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AccountStore(Path(directory) / "accounts.sqlite3")
            owner = store.ensure_owner("owner", "owner-password-long")
            wife = store.create("reader2", "reader-password-long", "Reader Two", ["books"])
            self.assertTrue(owner["isAdmin"])
            self.assertEqual(wife["contentTypes"], ["books"])
            self.assertEqual(store.authenticate("reader2", "reader-password-long")["id"], wife["id"])
            self.assertIsNone(store.authenticate("reader2", "wrong-password"))

    def test_password_reset_invalidates_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AccountStore(Path(directory) / "accounts.sqlite3")
            store.ensure_owner("owner", "owner-password-long")
            account = store.create("reader2", "reader-password-long")
            changed = store.reset_password(account["id"], "different-password-long")
            self.assertGreater(changed["sessionVersion"], account["sessionVersion"])

    def test_rejects_empty_content_access(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AccountStore(Path(directory) / "accounts.sqlite3")
            with self.assertRaises(AccountError):
                store.create("reader2", "reader-password-long", content_types=[])


if __name__ == "__main__":
    unittest.main()
