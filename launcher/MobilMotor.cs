// MobilMotor başlatıcı: sunucuyu konsol penceresi açmadan çalıştırır,
// görev çubuğu simgesinden yönetilir. Derleme: launcher\derle.cmd
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("MobilMotor")]
[assembly: System.Reflection.AssemblyProduct("MobilMotor")]
[assembly: System.Reflection.AssemblyDescription("Yerel Android cihaz ve emülatör kontrol paneli")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const string Name = "MobilMotor";
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string SessionFile = Path.Combine(Root, "data", ".oturum");
    static Process server;
    static NotifyIcon tray;
    static Control ui;
    static StreamWriter log;
    static bool quitting;
    static bool silent; // --sessiz: tarayıcı ve bildirim açmadan başla (Windows açılışı için)

    [STAThread]
    static void Main(string[] args)
    {
        silent = Array.IndexOf(args, "--sessiz") >= 0;
        if (Array.IndexOf(args, "--kaldir") >= 0)
        {
            Application.EnableVisualStyles();
            Uninstall();
            return;
        }
        bool first;
        using (var mutex = new Mutex(true, "Local\\MobilMotor-tek-kopya", out first))
        {
            // Zaten açıksa yenisini başlatma, paneli aç
            if (!first)
            {
                if (silent) return;
                if (!OpenPanel()) Error("MobilMotor zaten açılıyor, birkaç saniye sonra tekrar dene.");
                return;
            }
            Application.EnableVisualStyles();
            if (!File.Exists(Path.Combine(Root, "server.js")))
            {
                Error("server.js bulunamadı. MobilMotor.exe, MobilMotor klasörünün içinde durmalı.\n\nMasaüstünde kullanmak için kısayol oluştur.");
                return;
            }
            string node = FindNode();
            if (node == null)
            {
                Error("Node.js bulunamadı. nodejs.org adresinden Node.js kur, sonra tekrar aç.");
                return;
            }
            ui = new Control();
            ui.CreateControl();
            Application.ApplicationExit += delegate { Cleanup(); };
            BuildTray();
            StartServer(node);
            // Tarayıcıyı exe açar (varsayılan tarayıcı); sunucu hazır olunca
            if (!silent)
            {
                var t = new Thread(delegate () { if (!OpenPanel()) ui.BeginInvoke((MethodInvoker)delegate { Error("Panel açılamadı. Simgeye çift tıklayarak tekrar dene."); }); });
                t.IsBackground = true;
                t.Start();
            }
            Application.Run();
        }
    }

    static string FindNode()
    {
        // Kurulum paketiyle gelen Node önce
        string bundled = Path.Combine(Root, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            try
            {
                string p = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                if (dir.Trim().Length > 0 && File.Exists(p)) return p;
            }
            catch (ArgumentException) { }
        }
        string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(pf) ? pf : null;
    }

    static void StartServer(string node)
    {
        Directory.CreateDirectory(Path.Combine(Root, "data", "logs"));
        try { File.Delete(SessionFile); } catch (IOException) { }
        log = new StreamWriter(Path.Combine(Root, "data", "logs", "sunucu.log"), false, new UTF8Encoding(false));
        log.AutoFlush = true;

        var psi = new ProcessStartInfo(node, "server.js --launcher --no-open");
        psi.WorkingDirectory = Root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true; // exe kapanınca bu boru kapanır, sunucu da kapanır
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;

        server = new Process();
        server.StartInfo = psi;
        server.EnableRaisingEvents = true;
        server.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
        server.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
        server.Exited += delegate { ui.BeginInvoke((MethodInvoker)OnServerExit); };
        server.Start();
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
    }

    static void WriteLog(string line)
    {
        if (line == null) return;
        lock (log) log.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + line);
    }

    static void OnServerExit()
    {
        if (quitting) return;
        int code = server.ExitCode;
        if (code != 0)
        {
            string tail = "";
            try
            {
                string[] lines = File.ReadAllLines(Path.Combine(Root, "data", "logs", "sunucu.log"));
                int from = Math.Max(0, lines.Length - 6);
                tail = string.Join("\n", lines, from, lines.Length - from);
            }
            catch (IOException) { }
            Error("MobilMotor sunucusu beklenmedik şekilde durdu.\n\n" + tail + "\n\nAyrıntı: data\\logs\\sunucu.log");
        }
        // code 0: başka bir kopya zaten çalışıyordu, panel onun üzerinden açıldı
        Quit(false);
    }

    static void BuildTray()
    {
        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Paneli aç", null, delegate { OpenPanel(); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Ekran görüntüleri klasörü", null, delegate { OpenFolder("captures"); });
        menu.Items.Add("Makrolar klasörü", null, delegate { OpenFolder("macros"); });
        menu.Items.Add("Kayıtlar klasörü", null, delegate { OpenFolder("logs"); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Kapat", null, delegate { Quit(true); });

        tray = new NotifyIcon();
        tray.Text = "MobilMotor — yalnızca bu bilgisayarda";
        try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch (Exception) { tray.Icon = SystemIcons.Application; }
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenPanel(); };
        tray.Visible = true;
        if (!silent) tray.ShowBalloonTip(3000, "MobilMotor çalışıyor", "Panel tarayıcında açılıyor. Kapatmak için bu simgeye sağ tıkla.", ToolTipIcon.Info);
    }

    // Oturum dosyasındaki anahtarla paneli varsayılan tarayıcıda açar
    static bool OpenPanel()
    {
        for (int i = 0; i < 60; i++)
        {
            try
            {
                string json = File.ReadAllText(SessionFile);
                Match port = Regex.Match(json, "\"port\"\\s*:\\s*(\\d{2,5})");
                Match token = Regex.Match(json, "\"token\"\\s*:\\s*\"([a-f0-9]{64})\"");
                if (port.Success && token.Success)
                {
                    Process.Start("http://127.0.0.1:" + port.Groups[1].Value + "/giris?t=" + token.Groups[1].Value);
                    return true;
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            Thread.Sleep(250);
        }
        return false;
    }

    static void OpenFolder(string which)
    {
        string dir = Path.Combine(Root, "data", which);
        Directory.CreateDirectory(dir);
        Process.Start("explorer.exe", "\"" + dir + "\"");
    }

    static void Quit(bool ask)
    {
        if (quitting) return;
        if (ask) StopEmulators();
        quitting = true;
        Cleanup();
        Application.Exit();
    }

    // Arka planda açık kalan sanal cihazlar varsa sorar, istenirse düzgünce kapatır
    static void StopEmulators()
    {
        string sdk = Environment.GetEnvironmentVariable("ANDROID_HOME")
            ?? Environment.GetEnvironmentVariable("ANDROID_SDK_ROOT")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Android", "Sdk");
        string adb = Path.Combine(sdk, "platform-tools", "adb.exe");
        if (!File.Exists(adb)) return;
        string output = RunHidden(adb, "devices");
        MatchCollection emus = Regex.Matches(output, @"^(emulator-\d+)\s+device", RegexOptions.Multiline);
        if (emus.Count == 0) return;
        DialogResult r = MessageBox.Show(
            "Açık " + emus.Count + " sanal cihaz var. Onları da kapatayım mı?\n\nHayır dersen arka planda çalışmaya devam ederler.",
            Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button1);
        if (r != DialogResult.Yes) return;
        foreach (Match m in emus) RunHidden(adb, "-s " + m.Groups[1].Value + " emu kill");
    }

    static string RunHidden(string file, string args)
    {
        try
        {
            var psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            using (var p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd();
                p.WaitForExit(15000);
                return o;
            }
        }
        catch (Exception) { return ""; }
    }

    static void Cleanup()
    {
        quitting = true;
        if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
        if (server != null)
        {
            try
            {
                if (!server.HasExited)
                {
                    server.StandardInput.Close(); // sunucu kendini düzgünce kapatır
                    if (!server.WaitForExit(4000)) server.Kill();
                }
            }
            catch (Exception) { }
            server = null;
        }
        try { File.Delete(SessionFile); } catch (Exception) { }
    }

    // Denetim Masası › Programlar › Kaldır buradan çalışır (yönetici izni gerekmez)
    static void Uninstall()
    {
        // Yalnızca kurulum programının kurduğu klasörde çalışır (geliştirme klasörünü asla silmez)
        if (!File.Exists(Path.Combine(Root, "kurulum.json")))
        {
            Error("Bu klasör kurulum programıyla kurulmamış; kaldırma yapılmadı.");
            return;
        }
        if (MessageBox.Show("MobilMotor bu bilgisayardan kaldırılsın mı?", Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        bool wipe = MessageBox.Show(
            "Kayıtlar, makrolar, ekran görüntüleri, ağ çıkışları ve Google hesabı şablon bilgisi de silinsin mi?\n\n" +
            "Hayır dersen \"data\" klasörü kalır; yeniden kurarsan kaldığın yerden devam edersin.\n" +
            "(Sanal cihazların kendisi %USERPROFILE%\\.android\\avd altındadır, ona dokunulmaz.)",
            Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;

        // Çalışan MobilMotor ve sunucusunu kapat
        int self = Process.GetCurrentProcess().Id;
        foreach (Process p in Process.GetProcessesByName("MobilMotor"))
            if (p.Id != self)
                try { if (string.Equals(p.MainModule.FileName, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); } } catch (Exception) { }
        string node = Path.Combine(Root, "runtime", "node.exe");
        foreach (Process p in Process.GetProcessesByName("node"))
            try { if (string.Equals(p.MainModule.FileName, node, StringComparison.OrdinalIgnoreCase)) p.Kill(); } catch (Exception) { }

        foreach (string lnk in new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "MobilMotor.lnk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "MobilMotor.lnk") })
            try { File.Delete(lnk); } catch (Exception) { }
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\MobilMotor", false); } catch (Exception) { }
        try { Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true).DeleteValue("MobilMotor", false); } catch (Exception) { }

        // Kendisi çalışırken silinemeyen exe ve klasörü, kapanınca gizli bir komut siler
        string target = Root.TrimEnd('\\');
        foreach (string entry in Directory.GetFileSystemEntries(target))
        {
            string n = Path.GetFileName(entry);
            if (string.Equals(n, "MobilMotor.exe", StringComparison.OrdinalIgnoreCase)) continue;
            if (!wipe && string.Equals(n, "data", StringComparison.OrdinalIgnoreCase)) continue;
            try { if (Directory.Exists(entry)) Directory.Delete(entry, true); else File.Delete(entry); } catch (Exception) { }
        }
        string cmd = "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + Path.Combine(target, "MobilMotor.exe") + "\"" +
                     (wipe ? " & rmdir /s /q \"" + target + "\"" : "");
        var psi = new ProcessStartInfo("cmd.exe", cmd);
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.GetTempPath();
        Process.Start(psi);
        MessageBox.Show("MobilMotor kaldırıldı." + (wipe ? "" : "\n\nVerilerin şurada duruyor:\n" + Path.Combine(target, "data")), Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    static void Error(string msg)
    {
        MessageBox.Show(msg, Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
