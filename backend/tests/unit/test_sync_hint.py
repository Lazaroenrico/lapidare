from learnharness.core.sync_hint import is_network_fstype, mount_for, sync_folder_in
from learnharness.vault.sync_warning import vault_location_warning


def test_sync_folder_names():
    assert sync_folder_in(("/", "home", "u", "Dropbox", "Vault")) == "Dropbox"
    assert sync_folder_in(("/", "home", "u", "OneDrive - Corp", "v")) == "OneDrive - Corp"
    assert sync_folder_in(("/", "home", "u", "Sync", "v")) == "Sync"
    assert sync_folder_in(("/", "home", "u", "megatron", "v")) is None
    assert sync_folder_in(("/", "home", "u", "Documents", "StudyVault")) is None


def test_network_fstypes():
    for fs in ("nfs4", "cifs", "smb3", "sshfs", "9p", "fuse.rclone", "fuse.sshfs"):
        assert is_network_fstype(fs)
    for fs in ("ext4", "btrfs", "xfs", "tmpfs", "fuse.portal", "overlay"):
        assert not is_network_fstype(fs)


def test_longest_prefix_mount():
    mounts = [("/", "ext4"), ("/mnt", "ext4"), ("/mnt/share", "cifs")]
    assert mount_for("/mnt/share/vault", mounts) == "cifs"
    assert mount_for("/mnt/sharex/vault", mounts) == "ext4"
    assert mount_for("/home/u", mounts) == "ext4"


def test_warning_for_sync_folder_and_network_mount(tmp_path):
    synced = tmp_path / "Dropbox" / "vault"
    synced.mkdir(parents=True)
    assert "synced folder" in (vault_location_warning(synced) or "")
    local = tmp_path / "vault"
    local.mkdir()
    mounts = tmp_path / "mounts"
    mounts.write_text(f"/dev/sda1 / ext4 rw 0 0\nhost:/x {tmp_path.resolve()} nfs4 rw 0 0\n")
    assert "network" in (vault_location_warning(local, mounts) or "")
    mounts.write_text("/dev/sda1 / ext4 rw 0 0\n")
    assert vault_location_warning(local, mounts) is None
