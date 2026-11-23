package dev.yarvis.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.first

/** What the app remembers between launches. */
data class SavedSession(val serverUrl: String, val token: String)

private val Context.dataStore by preferencesDataStore(name = "yarvis")

/**
 * Keeps the server URL and the device token. The token is encrypted with an
 * AES-GCM key held in the Android Keystore, so the file alone doesn't give it
 * away and the key never leaves the device's keystore.
 */
class SessionStore(private val context: Context) {
    suspend fun load(): SavedSession? {
        val prefs = context.dataStore.data.first()
        val url = prefs[SERVER_URL] ?: return null
        val sealed = prefs[TOKEN] ?: return null
        val token = runCatching { unseal(sealed) }.getOrNull() ?: return null
        return SavedSession(url, token)
    }

    /** The last server signed in to, kept after sign-out so the field comes prefilled. */
    suspend fun lastServerUrl(): String? = context.dataStore.data.first()[SERVER_URL]

    suspend fun save(session: SavedSession) {
        val sealed = seal(session.token)
        context.dataStore.edit {
            it[SERVER_URL] = session.serverUrl
            it[TOKEN] = sealed
        }
    }

    suspend fun clearToken() {
        context.dataStore.edit { it.remove(TOKEN) }
    }

    suspend fun chatModel(): ChatModelChoice? {
        val prefs = context.dataStore.data.first()
        val provider = prefs[CHAT_PROVIDER] ?: return null
        val model = prefs[CHAT_MODEL] ?: return null
        return ChatModelChoice(provider, model)
    }

    suspend fun saveChatModel(provider: String, model: String) {
        context.dataStore.edit {
            it[CHAT_PROVIDER] = provider
            it[CHAT_MODEL] = model
        }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun unseal(sealed: String): String {
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
        return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "yarvis-device-token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        val SERVER_URL = stringPreferencesKey("server_url")
        val TOKEN = stringPreferencesKey("device_token")
        val CHAT_PROVIDER = stringPreferencesKey("chat_provider")
        val CHAT_MODEL = stringPreferencesKey("chat_model")
    }
}
