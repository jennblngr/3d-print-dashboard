package com.jennblngr.printdashboard.nfc;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.NfcA;
import android.os.Bundle;
import android.widget.Toast;

import java.io.IOException;

/**
 * The only component of the app, and it never shows anything. Started by a chip held against the
 * phone, it reads the chip memory and opens the dashboard with it; started from its icon, it just
 * opens the dashboard. It only ever reads: nothing is written to a chip.
 */
public class TagActivity extends Activity {
    // The TigerTag data ends at page 0x27; a chip is read 4 pages at a time.
    private static final int PAGES = 40;
    private static final int PAGE_SIZE = 4;
    private static final byte CMD_READ = 0x30;
    // Format identifiers stored in page 0x04: TigerTag and TigerTag+.
    private static final int ID_TIGERTAG = 0x5BF59264;
    private static final int ID_TIGERTAG_PLUS = 0xBC0FCB97;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        Tag tag = NfcAdapter.ACTION_TECH_DISCOVERED.equals(intent.getAction())
                ? intent.<Tag>getParcelableExtra(NfcAdapter.EXTRA_TAG)
                : null;
        if (tag == null) {
            openDashboard("");
        } else {
            handleTag(tag);
        }
        finish();
    }

    private void handleTag(Tag tag) {
        byte[] memory;
        try {
            memory = readMemory(tag);
        } catch (IOException | RuntimeException e) {
            // Other kinds of NFC-A tags (cards, badges) do not answer this read command either.
            toast(R.string.read_failed);
            return;
        }
        int format = ((memory[16] & 0xFF) << 24) | ((memory[17] & 0xFF) << 16)
                | ((memory[18] & 0xFF) << 8) | (memory[19] & 0xFF);
        if (format != ID_TIGERTAG && format != ID_TIGERTAG_PLUS) {
            toast(R.string.not_tigertag);
            return;
        }
        // After "#": browsers keep that part on the phone and never send it to the server.
        openDashboard("#tigertag=" + toHex(memory));
    }

    /** Reads pages 0x00 to 0x27 with the standard NTAG / MIFARE Ultralight READ command. */
    private static byte[] readMemory(Tag tag) throws IOException {
        NfcA nfc = NfcA.get(tag);
        if (nfc == null) {
            throw new IOException("not an NFC-A tag");
        }
        byte[] memory = new byte[PAGES * PAGE_SIZE];
        try {
            nfc.connect();
            for (int page = 0; page < PAGES; page += 4) {
                byte[] chunk = nfc.transceive(new byte[] {CMD_READ, (byte) page});
                if (chunk == null || chunk.length != 4 * PAGE_SIZE) {
                    throw new IOException("unexpected answer at page " + page);
                }
                System.arraycopy(chunk, 0, memory, page * PAGE_SIZE, chunk.length);
            }
        } finally {
            try {
                nfc.close();
            } catch (IOException ignored) {
                // nothing left to release
            }
        }
        return memory;
    }

    private void openDashboard(String fragment) {
        Uri url = Uri.parse(getString(R.string.dashboard_url) + fragment);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            toast(R.string.no_browser);
        }
    }

    private void toast(int message) {
        Toast.makeText(getApplicationContext(), message, Toast.LENGTH_LONG).show();
    }

    private static String toHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        }
        return out.toString();
    }
}
