package dev.yarvis.android.ui.signin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun SignInScreen(viewModel: SignInViewModel, notice: String?, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Sign in to Yarvis", style = MaterialTheme.typography.headlineSmall)
        notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text(
            "Use your server's HTTPS address, such as the name tailscale serve gives it.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = state.server,
            onValueChange = { v -> viewModel.update { it.copy(server = v) } },
            label = { Text("Server") },
            placeholder = { Text("yarvis.your-tailnet.ts.net") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.passphrase,
            onValueChange = { v -> viewModel.update { it.copy(passphrase = v) } },
            label = { Text("Passphrase") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.code,
            onValueChange = { v -> viewModel.update { it.copy(code = v) } },
            label = { Text(if (state.useBackupCode) "Backup code" else "Code from your authenticator app") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = if (state.useBackupCode) KeyboardType.Ascii else KeyboardType.NumberPassword,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(
                checked = state.useBackupCode,
                onCheckedChange = { v -> viewModel.update { it.copy(useBackupCode = v, code = "") } },
            )
            Text("Use a backup code", modifier = Modifier.padding(start = 8.dp))
        }
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = { v -> viewModel.update { it.copy(deviceName = v) } },
            label = { Text("Device name") },
            supportingText = { Text("Shown on the server's devices list.") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = viewModel::submit, enabled = state.canSubmit, modifier = Modifier.fillMaxWidth()) {
            if (state.busy) CircularProgressIndicator(modifier = Modifier.padding(2.dp)) else Text("Sign in")
        }
        Text(
            "First-time setup happens in the web UI.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
