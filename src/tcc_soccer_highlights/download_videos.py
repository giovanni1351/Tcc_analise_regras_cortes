from SoccerNet.Downloader import SoccerNetDownloader

myDownloader = SoccerNetDownloader(LocalDirectory="videos")
myDownloader.password = "s0cc3rn3t"  # senha do NDA do SoccerNet

# Troque pelo jogo que quiser analisar (formato: "liga/temporada/data - hora time1 x time2")
GAME = "england_epl/2014-2015/2015-02-21 - 18-00 Chelsea 1 - 1 Burnley"

# 1) Vídeo do jogo (224p aqui só para testes rápidos e leves; use 720p se quiser mais qualidade)


# 2) Labels-v2.json: eventos oficiais anotados do jogo (gol, cartão, etc.)


def download():
    myDownloader.downloadGames(
        files=["1_224p.mkv","2_224p.mkv","1_720p.mkv"],
        split=["train", "valid", "test"],
    )
def download_labels():
    
    myDownloader.downloadGames(
        files=["Labels-v2.json"],
        split=["train", "valid", "test"],
    )