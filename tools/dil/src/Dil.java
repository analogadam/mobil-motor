// MobilMotor: sistem dilini root olmadan değiştirir. app_process ile "shell" kullanıcısı olarak çalışır;
// shell'in CHANGE_CONFIGURATION izni vardır. Kullanım: CLASSPATH=dil.dex app_process / Dil tr-TR
import android.content.res.Configuration;
import android.os.LocaleList;
import java.lang.reflect.Method;

public class Dil {
    public static void main(String[] args) throws Exception {
        String tag = args.length > 0 ? args[0] : "tr-TR";
        Object am = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
        Configuration c = (Configuration) am.getClass().getMethod("getConfiguration").invoke(am);
        c.setLocales(LocaleList.forLanguageTags(tag));
        Configuration.class.getField("userSetLocale").setBoolean(c, true);
        Method m = am.getClass().getMethod("updatePersistentConfiguration", Configuration.class);
        m.invoke(am, c);
        System.out.println("dil: " + tag);
    }
}
