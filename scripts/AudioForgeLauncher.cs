using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("AudioForge")]
[assembly: AssemblyProduct("AudioForge")]
[assembly: AssemblyDescription("AudioForge local launcher")]
[assembly: AssemblyVersion("1.14.0.0")]
internal static class AudioForgeLauncher
{
    [STAThread]
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string batch = Path.Combine(root, "run.bat");
        string log = null;
        try
        {
            if (!File.Exists(batch)) throw new FileNotFoundException("AudioForge.exe를 run.bat과 같은 폴더에 두세요.", batch);
            string logs = Path.Combine(root, "AudioForge_data", "launcher");
            Directory.CreateDirectory(logs);
            log = Path.Combine(logs, DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Process.GetCurrentProcess().Id + ".log");
            var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe");
            info.Arguments = "/d /s /c \"\"" + batch + "\"\"";
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["AUDIOFORGE_NO_PAUSE"] = "1";
            using (var writer = new StreamWriter(log, false, new UTF8Encoding(false)))
            using (var process = new Process())
            {
                writer.AutoFlush = true;
                object gate = new object();
                process.StartInfo = info;
                DataReceivedEventHandler record = delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock (gate) writer.WriteLine(e.Data); };
                process.OutputDataReceived += record;
                process.ErrorDataReceived += record;
                process.Start();
                process.BeginOutputReadLine(); process.BeginErrorReadLine();
                process.WaitForExit();
                if (process.ExitCode != 0) throw new Exception("실행을 마치지 못했습니다. 오류 코드: " + process.ExitCode);
            }
            return 0;
        }
        catch (Exception e)
        {
            MessageBox.Show(e.Message + (log == null ? "" : "\n\n실행 기록:\n" + log), "AudioForge", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
